import { Redis } from 'ioredis';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import type {
  ChainClient,
  TransferSigner,
} from '../../../libs/chain/src/chain-client';
import { RpcError } from '../../../libs/chain/src/rpc-error';
import { testDatabase } from '../../../libs/db/src/test-database';
import { OrderSender } from './send-order';
import { RedisLock } from './redis-lock';

const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
const day = new Date('2026-10-20');
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let chain: ScriptedChain;
let sender: OrderSender;
class ScriptedChain implements ChainClient, TransferSigner {
  signed = 0;
  accepted = new Set<Hex>();
  receipts = new Set<Hex>();
  fail: 'sign' | 'broadcast' | 'after-broadcast' | null = null;
  getHead = async () => ({ number: 1n, hash: '0xaa' as Hex });
  getFinalized = async () => 0n;
  getBlockHash = async () => '0xaa' as Hex;
  getTransferLogs = async () => [];
  getBalances = async () => ({ native: 1n, usdc: 500n });
  getNonce = async () => 3;
  getTransactionReceipt = async (hash: Hex) =>
    this.receipts.has(hash) ? { blockNumber: 1n } : null;
  async signTransfer(
    _from: Address,
    _to: Address,
    amount: bigint,
    nonce: number,
  ): Promise<Hex> {
    if (this.fail === 'sign') throw new RpcError('permanent');
    this.signed++;
    return toHex(`${amount}:${nonce}:${this.signed}`);
  }
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    if (this.fail === 'broadcast') throw new RpcError('timeout');
    const hash = keccak256(raw);
    this.accepted.add(hash);
    if (this.fail === 'after-broadcast') {
      this.receipts.add(hash);
      throw new RpcError('timeout');
    }
    return hash;
  }
}
beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis('redis://127.0.0.1:56379', { maxRetriesPerRequest: 1 });
});
afterAll(async () => {
  await redis.quit();
  await database.close();
});
beforeEach(async () => {
  const db = database.db;
  await db.incident.deleteMany();
  await db.payment.deleteMany();
  await db.order.deleteMany();
  await db.dailyBudget.deleteMany();
  await db.walletNonce.deleteMany();
  await db.dailyBudget.create({
    data: {
      day,
      targetCount: 10,
      targetAmount: 1000000n,
      reservedCount: 1,
      reservedAmount: 100n,
    },
  });
  chain = new ScriptedChain();
  sender = new OrderSender(
    db,
    chain,
    chain,
    new RedisLock(redis, `test-${Date.now()}-${Math.random()}`),
    { buyer, shop, chainId: 84532 },
  );
});
async function order() {
  return database.db.order.create({
    data: {
      item: 'Duck',
      price: 99n,
      expectedAmount: 100n,
      source: 'visitor',
      createdAt: day,
      expiresAt: new Date(day.getTime() + 1800000),
    },
  });
}
it('rebroadcasts the stored transaction after a crash before broadcast without signing again', async () => {
  const row = await order();
  chain.fail = 'broadcast';
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'timeout',
  });
  const stored = await database.db.order.findUniqueOrThrow({
    where: { id: row.id },
  });
  expect(stored.transactionHash).toBe(
    keccak256(stored.signedTransaction as Hex),
  );
  chain.fail = null;
  await sender.sendForOrder(row.id);
  expect(chain.signed).toBe(1);
  expect(chain.accepted).toEqual(new Set([stored.transactionHash]));
  expect(await database.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'sent',
    orderId: row.id,
    transactionHash: stored.transactionHash,
  });
});
it('finds the landed transaction after a crash following broadcast without signing a second transfer', async () => {
  const row = await order();
  chain.fail = 'after-broadcast';
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'timeout',
  });
  chain.fail = null;
  await sender.sendForOrder(row.id);
  expect(chain.signed).toBe(1);
  expect(chain.accepted.size).toBe(1);
  expect(await database.db.payment.count()).toBe(1);
});
it('allocates distinct durable nonces when the pending chain nonce has not advanced', async () => {
  const first = await order();
  const second = await order();
  await sender.sendForOrder(first.id);
  await sender.sendForOrder(second.id);
  const rows = await database.db.order.findMany({ orderBy: { nonce: 'asc' } });
  expect(rows.map((row) => row.nonce)).toEqual([3n, 4n]);
});
it('keeps an unknown send reserved and records a safe handling note', async () => {
  const row = await order();
  chain.fail = 'broadcast';
  await expect(sender.sendForOrder(row.id)).rejects.toBeInstanceOf(RpcError);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 100n });
  expect(await database.db.incident.findFirstOrThrow()).toMatchObject({
    kind: 'send_failed',
    howHandled: expect.stringContaining('same signed transaction'),
  });
});
it('releases a known unsigned failure once and never sends that order on a later retry', async () => {
  const row = await order();
  chain.fail = 'sign';
  await expect(sender.sendForOrder(row.id)).rejects.toBeInstanceOf(RpcError);
  chain.fail = null;
  await sender.sendForOrder(row.id);
  expect(chain.accepted.size).toBe(0);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
});
