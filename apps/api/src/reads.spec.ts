import { FastifyAdapter } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { testDatabase } from '../../../libs/db/testing/database';
import { apiSchema } from '../../../libs/config/src';
import { registerReads } from './reads';
import {
  serviceLimiter,
  cooldownKey,
} from '../../../libs/chain/src/service-limiter';
import { RpcError } from '../../../libs/chain/src/rpc-error';

const config = apiSchema.parse({
  DATABASE_URL: 'postgresql://unused/unused',
  REDIS_URL: 'redis://127.0.0.1:56379',
  CHAIN_ID: 84532,
  RPC_URL: 'https://example.com',
  USDC_ADDRESS: `0x${'33'.repeat(20)}`,
  BUYER_ADDRESS: `0x${'11'.repeat(20)}`,
  SHOP_ADDRESS: `0x${'22'.repeat(20)}`,
  NOTICE_SECRET: 'test-secret'.repeat(4),
  WEB_ORIGIN: 'http://localhost:5173',
});
let database: Awaited<ReturnType<typeof testDatabase>>;
let adapter: FastifyAdapter;
let redis: Redis;
let queue: Queue;
let time = 0;
beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis(config.REDIS_URL);
  queue = new Queue(`api-test-${randomUUID()}`, {
    connection: { url: config.REDIS_URL },
  });
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
  await database.close();
});
beforeEach(async () => {
  await database.db.$executeRawUnsafe(
    'TRUNCATE payments, orders, ledger_entries, incidents, cursors, scan_gaps CASCADE',
  );
  time = 0;
  adapter = new FastifyAdapter();
  registerReads(adapter.getInstance(), database.db, config, {
    chain: {
      getHead: async () => ({ number: 100n, hash: '0x01' }),
      getBalances: async (address) =>
        address === config.BUYER_ADDRESS
          ? { native: 1n, usdc: 20000000n }
          : { native: 2000000000000000n, usdc: 2n },
    },
    redis,
    queues: { buyer: queue },
    now: () => time,
  });
});
afterEach(async () => {
  await adapter.close();
});
const payment = (data = {}) =>
  database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: randomUUID(),
      amount: 14000731n,
      transactionHash: '0x123',
      receivedAt: new Date('2026-10-20T12:00:00Z'),
      ...data,
    },
  });
it('returns recent payments with safe order details, exact amounts and explorer links', async () => {
  const order = await database.db.order.create({
    data: {
      item: 'Duck',
      price: 14000000n,
      expectedAmount: 14000731n,
      source: 'visitor',
      expiresAt: new Date(),
      signedTransaction: 'private signed bytes',
    },
  });
  await payment({ orderId: order.id, blockNumber: 91n, confirmations: 9 });
  await payment({ receivedAt: new Date('2026-10-20T11:00:00Z') });
  const response = await adapter.getInstance().inject('/payments?limit=1');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([
    expect.objectContaining({
      amount: '14000731',
      blockNumber: '91',
      confirmations: 9,
      explorerUrl: 'https://sepolia.basescan.org/tx/0x123',
      order: expect.objectContaining({
        id: order.id,
        item: 'Duck',
        price: '14000000',
      }),
    }),
  ]);
  expect(response.body).not.toContain('signedTransaction');
});
it('returns newest incidents and rejects limits outside one to one hundred', async () => {
  for (const day of [19, 20])
    await database.db.incident.create({
      data: {
        kind: 'duplicate',
        whatHappened: `Day ${day}`,
        howHandled: 'Skipped',
        createdAt: new Date(`2026-10-${day}T00:00:00Z`),
      },
    });
  const response = await adapter.getInstance().inject('/incidents?limit=1');
  expect(response.json()).toEqual([
    expect.objectContaining({ whatHappened: 'Day 20' }),
  ]);
  for (const route of ['/incidents', '/payments'])
    for (const limit of ['0', '101', 'abc', '1.5'])
      expect(
        (await adapter.getInstance().inject(`${route}?limit=${limit}`))
          .statusCode,
      ).toBe(400);
});
it('computes statistics from ledger rows and incidents and refreshes after five seconds', async () => {
  expect((await adapter.getInstance().inject('/stats')).json()).toEqual({
    settledCount: 0,
    averageTimeToSettleMs: null,
    duplicatesSkipped: 0,
    failuresRecovered: 0,
  });
  const row = await payment({
    settledAt: new Date('2026-10-20T12:00:08Z'),
    stage: 'notified',
  });
  await database.db.ledgerEntry.create({
    data: { paymentId: row.id, amount: row.amount },
  });
  await database.db.incident.createMany({
    data: ['duplicate', 'gap_recovered', 'rpc_failed'].map((kind) => ({
      kind,
      whatHappened: kind,
      howHandled: 'Handled',
    })),
  });
  time = 4999;
  expect(
    (await adapter.getInstance().inject('/stats')).json().settledCount,
  ).toBe(0);
  time = 5000;
  expect((await adapter.getInstance().inject('/stats')).json()).toEqual({
    settledCount: 1,
    averageTimeToSettleMs: 8000,
    duplicatesSkipped: 1,
    failuresRecovered: 1,
  });
});
it('reports head, scoped cursor lag, open gaps, queued work and live balance warnings', async () => {
  await database.db.cursor.create({
    data: {
      name: `chain-${config.CHAIN_ID}-${config.SHOP_ADDRESS}`,
      blockNumber: 92n,
      blockHash: '0x01',
    },
  });
  await database.db.scanGap.create({
    data: {
      fromBlock: 1n,
      toBlock: 5n,
      errorCategory: 'timeout',
      nextRetryAt: new Date(),
    },
  });
  await queue.add(
    'visitor-purchase',
    { orderId: randomUUID() },
    { priority: 1 },
  );
  const response = await adapter.getInstance().inject('/health');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    head: '100',
    cursor: '92',
    lag: '8',
    openGaps: 1,
    queueDepth: { buyer: 1 },
    balances: {
      buyer: { native: '1', usdc: '20000000', lowNative: true, lowUsdc: false },
      shop: {
        native: '2000000000000000',
        usdc: '2',
        lowNative: false,
        lowUsdc: true,
      },
    },
    cooldowns: { buyer: 0, tracker: 0, api: 0 },
  });
});
it('puts a new sent purchase ahead of older received payments', async () => {
  await payment();
  const sent = await payment({
    stage: 'sent',
    receivedAt: null,
    sentAt: new Date('2026-10-20T12:01:00Z'),
  });
  expect(
    (await adapter.getInstance().inject('/payments?limit=1')).json()[0].id,
  ).toBe(sent.id);
});

it('reports an actual rate-limit cooldown and its expiry from live Redis state', async () => {
  const limiter = serviceLimiter(redis, 'tracker', 5, 100);
  await expect(
    limiter.run(async () => {
      throw new RpcError('rate_limit');
    }),
  ).rejects.toThrow();
  const cooling = (await adapter.getInstance().inject('/health')).json();
  expect(cooling.cooldowns.tracker).toBeGreaterThan(0);
  await redis.pexpire(cooldownKey('tracker'), 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(
    (await adapter.getInstance().inject('/health')).json().cooldowns.tracker,
  ).toBe(0);
});
it('reports an unknown cursor and lag before the tracker initializes', async () => {
  expect((await adapter.getInstance().inject('/health')).json()).toMatchObject({
    cursor: null,
    lag: null,
    openGaps: 0,
  });
});
