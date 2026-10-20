import { ScriptedChain } from '../../../libs/chain/testing/scripted-chain';
import { Redis } from 'ioredis';
import { keccak256, type Hex } from 'viem';
import { RpcError } from '../../../libs/chain/src/rpc-error';
import { testDatabase } from '../../../libs/db/testing/database';
import { OrderSender } from './send-order';
import { RedisLock } from './redis-lock';

const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
const day = new Date('2026-10-20');
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let chain: ScriptedChain;
let sender: OrderSender;
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
  sender = new OrderSender(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'restarted-buyer'),
    { buyer, shop, chainId: 84532 },
  );
  await sender.sendForOrder(row.id);
  expect(chain.signed).toBe(1);
  expect(await chain.getBalances(buyer)).toMatchObject({ usdc: 400n });
  expect(await chain.getBalances(shop)).toMatchObject({ usdc: 600n });
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
  sender = new OrderSender(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'restarted-buyer'),
    { buyer, shop, chainId: 84532 },
  );
  await sender.sendForOrder(row.id);
  expect(chain.signed).toBe(1);
  expect(await chain.getBalances(buyer)).toMatchObject({ usdc: 400n });
  expect(await chain.getBalances(shop)).toMatchObject({ usdc: 600n });
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

it('retains an uncertain send for manual review after automatic retries are exhausted', async () => {
  const row = await order();
  chain.fail = 'broadcast';
  await expect(sender.sendForOrder(row.id, true)).rejects.toMatchObject({
    kind: 'timeout',
  });
  const incident = await database.db.incident.findFirstOrThrow();
  expect(incident.howHandled).toContain('manual review');
  expect(
    await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
  ).toMatchObject({ sendState: 'review' });
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 100n });
});
it('does not sign an unpaid order that expired before its queued send began', async () => {
  const row = await order();
  await database.db.order.update({
    where: { id: row.id },
    data: { status: 'expired' },
  });
  await sender.sendForOrder(row.id);
  expect(chain.signed).toBe(0);
  expect(chain.accepted.size).toBe(0);
});

it('retains a signed transfer for manual review when the provider permanently rejects broadcast', async () => {
  const row = await order();
  chain.fail = 'permanent-broadcast';
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'permanent',
  });
  expect(
    await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
  ).toMatchObject({ sendState: 'review' });
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 100n });
  expect((await database.db.incident.findFirstOrThrow()).howHandled).toContain(
    'manual review',
  );
});
it('fences simultaneous nonce allocators even when they hold separate Redis leases', async () => {
  const secondSender = new OrderSender(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'separate-lease'),
    { buyer, shop, chainId: 84532 },
  );
  const first = await order();
  const second = await order();
  await Promise.all([
    sender.sendForOrder(first.id),
    secondSender.sendForOrder(second.id),
  ]);
  expect(
    (await database.db.order.findMany({ orderBy: { nonce: 'asc' } })).map(
      (row) => row.nonce,
    ),
  ).toEqual([3n, 4n]);
  expect(chain.accepted.size).toBe(2);
});
