import { ScriptedChain } from '../../../../libs/chain/testing/scripted-chain';
import { Redis } from 'ioredis';
import { keccak256, type Hex } from 'viem';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { testDatabase } from '../../../../libs/db/testing/database';
import { OrderSenderService } from './order-sender.service';
import { RedisLock } from './redis-lock';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import { fakeConfig } from '../../../../libs/config/testing/config';
import type { BuyerConfig } from '../buyer-config';

const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
const day = new Date('2026-10-20');
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let chain: ScriptedChain;
let sender: OrderSenderService;
beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 1 });
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
  sender = new OrderSenderService(
    db,
    chain,
    chain,
    new RedisLock(redis, `test-${Date.now()}-${Math.random()}`),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
  );
});
async function order(source: 'visitor' | 'schedule' = 'visitor') {
  return database.db.order.create({
    data: {
      item: 'Duck',
      price: 99n,
      expectedAmount: 100n,
      source,
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
  sender = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'restarted-buyer'),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
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
  sender = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'restarted-buyer'),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
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
  const incident = await database.db.incident.findFirstOrThrow();
  expect(incident.kind).toBe('send_failed');
  expect(incident.howHandled).toContain('same signed transaction');
});
it('releases a known unsigned failure once and never sends that order on a later retry', async () => {
  const row = await order('schedule');
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
it('leaves the scheduled budget alone when a visitor order fails before it is signed', async () => {
  const row = await order();
  chain.fail = 'sign';
  await expect(sender.sendForOrder(row.id)).rejects.toBeInstanceOf(RpcError);
  expect(
    await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
  ).toMatchObject({ sendState: 'failed', status: 'expired' });
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 100n });
});
it('leaves the scheduled budget alone when an unsent visitor order expires', async () => {
  const row = await order();
  await database.db.order.update({
    where: { id: row.id },
    data: { status: 'expired' },
  });
  await sender.sendForOrder(row.id);
  expect(
    await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
  ).toMatchObject({ sendState: 'failed' });
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 100n });
});
it('releases the reservation when an unsent scheduled order expires', async () => {
  const row = await order('schedule');
  await database.db.order.update({
    where: { id: row.id },
    data: { status: 'expired' },
  });
  await sender.sendForOrder(row.id);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
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
  const secondSender = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'separate-lease'),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
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
it('sends a first attempt without a receipt lookup or nonce call when the nonce row exists', async () => {
  await database.db.walletNonce.create({
    data: { address: buyer, nextNonce: 5n },
  });
  const row = await order();
  await sender.sendForOrder(row.id);
  expect(chain.calls).toEqual(['sendRawTransaction']);
  expect(
    (await database.db.order.findUniqueOrThrow({ where: { id: row.id } }))
      .nonce,
  ).toBe(5n);
});
it('checks the receipt on a retry', async () => {
  await database.db.walletNonce.create({
    data: { address: buyer, nextNonce: 5n },
  });
  const row = await order();
  chain.fail = 'broadcast';
  await expect(sender.sendForOrder(row.id)).rejects.toBeInstanceOf(RpcError);
  chain.fail = null;
  chain.calls = [];
  await sender.sendForOrder(row.id);
  expect(chain.calls).toEqual(['getTransactionReceipt', 'sendRawTransaction']);
});
it('resyncs a stale nonce and sends the order once', async () => {
  await database.db.walletNonce.create({
    data: { address: buyer, nextNonce: 1n },
  });
  const row = await order();
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'transient',
  });
  const reset = await database.db.order.findUniqueOrThrow({
    where: { id: row.id },
  });
  expect(reset).toMatchObject({
    nonce: null,
    signedTransaction: null,
    transactionHash: null,
    sendState: 'pending',
  });
  await sender.sendForOrder(row.id);
  const sent = await database.db.order.findUniqueOrThrow({
    where: { id: row.id },
  });
  expect(sent).toMatchObject({ sendState: 'sent', nonce: 3n });
  expect(chain.signedNonces).toEqual([1, 3]);
  expect(chain.accepted).toEqual(new Set([sent.transactionHash]));
  expect(
    await database.db.incident.findMany({ where: { kind: 'nonce_resynced' } }),
  ).toMatchObject([
    {
      whatHappened: 'Nonce was behind the chain.',
      howHandled: 'Moved the nonce forward and signed the transfer again.',
    },
  ]);
});
it('does not re-sign when the stored transfer has landed', async () => {
  await database.db.walletNonce.create({
    data: { address: buyer, nextNonce: 1n },
  });
  const row = await order();
  chain.getTransactionReceipt = () => {
    chain.calls.push('getTransactionReceipt');
    return Promise.resolve({ blockNumber: 1n, status: 'success' as const });
  };
  await sender.sendForOrder(row.id);
  const sent = await database.db.order.findUniqueOrThrow({
    where: { id: row.id },
  });
  expect(sent).toMatchObject({ sendState: 'sent', nonce: 1n });
  expect(chain.signed).toBe(1);
  expect(chain.calls).toEqual([
    'sendRawTransaction',
    'getConfirmedNonce',
    'getTransactionReceipt',
  ]);
  expect(
    await database.db.incident.count({ where: { kind: 'nonce_resynced' } }),
  ).toBe(0);
});
it('keeps the nonce row from moving backwards on resync', async () => {
  await database.db.walletNonce.create({
    data: { address: buyer, nextNonce: 1n },
  });
  const row = await order();
  chain.fail = 'broadcast';
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'timeout',
  });
  await database.db.walletNonce.update({
    where: { address: buyer },
    data: { nextNonce: 10n },
  });
  chain.fail = null;
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'transient',
  });
  expect(
    (
      await database.db.walletNonce.findUniqueOrThrow({
        where: { address: buyer },
      })
    ).nextNonce,
  ).toBe(10n);
  expect(
    await database.db.incident.count({ where: { kind: 'nonce_resynced' } }),
  ).toBe(1);
  expect(
    await database.db.incident.count({ where: { kind: 'send_failed' } }),
  ).toBe(1);
});
it('does not clear a transfer that another sender replaced', async () => {
  await database.db.walletNonce.create({
    data: { address: buyer, nextNonce: 1n },
  });
  const row = await order();
  const replacement = `0x${'ab'.repeat(32)}`;
  chain.getTransactionReceipt = async () => {
    await database.db.order.update({
      where: { id: row.id },
      data: { transactionHash: replacement },
    });
    return null;
  };
  chain.fail = 'broadcast';
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'timeout',
  });
  chain.fail = null;
  const before = await database.db.order.findUniqueOrThrow({
    where: { id: row.id },
  });
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'transient',
  });
  expect(
    await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
  ).toMatchObject({
    nonce: 1n,
    signedTransaction: before.signedTransaction,
    transactionHash: replacement,
  });
  expect(
    await database.db.incident.count({ where: { kind: 'nonce_resynced' } }),
  ).toBe(0);
});
async function sendThree() {
  const rows = [await order(), await order(), await order()];
  for (const row of rows) await sender.sendForOrder(row.id);
  return rows;
}
it('counts broadcast transfers the tracker has not seen', async () => {
  const rows = await sendThree();
  expect(await sender.inFlight()).toBe(3);
  await database.db.payment.updateMany({
    where: { orderId: rows[0]?.id },
    data: { stage: 'received' },
  });
  expect(await sender.inFlight()).toBe(2);
});
it('counts in-flight transfers from the database after a restart', async () => {
  await sendThree();
  const restarted = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'restarted-buyer'),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
  );
  expect(await restarted.inFlight()).toBe(3);
});

describe('transfers the tracker has not seen', () => {
  const checkedAt = new Date(Date.now() + 30 * 60 * 1000);
  async function sentOrder(source: 'visitor' | 'schedule' = 'visitor') {
    const row = await order(source);
    await sender.sendForOrder(row.id);
    chain.calls = [];
    return database.db.order.findUniqueOrThrow({ where: { id: row.id } });
  }
  it('closes a reverted transfer on the first run', async () => {
    const row = await sentOrder('schedule');
    chain.reverted.add(row.transactionHash as Hex);
    expect(await sender.inFlight()).toBe(1);
    await sender.checkUnseen(checkedAt);
    expect(
      await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ sendState: 'failed', status: 'expired' });
    expect(await sender.inFlight()).toBe(0);
    const payment = await database.db.payment.findFirstOrThrow({
      where: { orderId: row.id },
    });
    expect(payment.stage).toBe('sent');
    expect(
      await database.db.incident.findFirstOrThrow({
        where: { kind: 'send_reverted' },
      }),
    ).toMatchObject({
      paymentId: payment.id,
      whatHappened: 'Transfer reverted on chain.',
      howHandled: 'Closed the order; nothing was credited.',
    });
    expect(
      await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
    ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
  });
  it('closes a dropped transfer only on the second run', async () => {
    const row = await sentOrder();
    chain.nonce = Number(row.nonce) + 1;
    await sender.checkUnseen(checkedAt);
    expect(
      await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ sendState: 'sent', status: 'open' });
    expect(await database.db.incident.count()).toBe(0);
    await sender.checkUnseen(checkedAt);
    expect(
      await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ sendState: 'failed', status: 'expired' });
    expect(await sender.inFlight()).toBe(0);
    expect(
      await database.db.incident.count({ where: { kind: 'send_dropped' } }),
    ).toBe(1);
    expect(chain.calls).not.toContain('sendRawTransaction');
    expect(
      await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
    ).toMatchObject({ reservedCount: 1, reservedAmount: 100n });
  });
  it('clears the suspicion when a receipt appears', async () => {
    const row = await sentOrder();
    chain.nonce = Number(row.nonce) + 1;
    await sender.checkUnseen(checkedAt);
    chain.receipts.add(row.transactionHash as Hex);
    await sender.checkUnseen(checkedAt);
    chain.receipts.delete(row.transactionHash as Hex);
    await sender.checkUnseen(checkedAt);
    expect(
      await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ sendState: 'sent', status: 'open' });
    expect(await database.db.incident.count()).toBe(0);
  });
  it('clears the suspicion when the order leaves the unseen list', async () => {
    const row = await sentOrder();
    chain.nonce = Number(row.nonce) + 1;
    await sender.checkUnseen(checkedAt);
    await database.db.payment.updateMany({
      where: { orderId: row.id },
      data: { stage: 'received' },
    });
    await sender.checkUnseen(checkedAt);
    await database.db.payment.updateMany({
      where: { orderId: row.id },
      data: { stage: 'sent' },
    });
    await sender.checkUnseen(checkedAt);
    expect(
      await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ sendState: 'sent', status: 'open' });
    expect(await database.db.incident.count()).toBe(0);
  });
  it('clears the suspicion when the nonce is no longer past the order', async () => {
    const row = await sentOrder();
    chain.nonce = Number(row.nonce) + 1;
    await sender.checkUnseen(checkedAt);
    chain.nonce = Number(row.nonce);
    await sender.checkUnseen(checkedAt);
    chain.nonce = Number(row.nonce) + 1;
    await sender.checkUnseen(checkedAt);
    expect(
      await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ sendState: 'sent' });
  });
  it('rebroadcasts the stored transfer while its nonce is unused', async () => {
    const row = await sentOrder();
    await sender.checkUnseen(checkedAt);
    expect(chain.calls).toEqual([
      'getConfirmedNonce',
      'getTransactionReceipt',
      'sendRawTransaction',
    ]);
    expect(chain.signed).toBe(1);
    expect(
      await database.db.order.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ sendState: 'sent', status: 'open' });
    expect(await sender.inFlight()).toBe(1);
  });
  it('leaves a landed transfer and a recent one alone', async () => {
    const landed = await sentOrder();
    chain.receipts.add(landed.transactionHash as Hex);
    await sender.checkUnseen(checkedAt);
    expect(chain.calls).not.toContain('sendRawTransaction');
    chain.calls = [];
    await sender.checkUnseen(new Date());
    expect(chain.calls).toEqual([]);
    expect(await sender.inFlight()).toBe(1);
  });
});
