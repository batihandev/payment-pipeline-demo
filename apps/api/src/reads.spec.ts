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
import { testRedisUrl } from '../../../libs/config/testing/redis';

const config = apiSchema.parse({
  DATABASE_URL: 'postgresql://unused/unused',
  REDIS_URL: testRedisUrl(),
  CHAIN_ID: 84532,
  CONFIRMATIONS: 7,
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
const today = Date.parse('2026-10-22T12:00:00Z');
let time = today;
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
  time = today;
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
    receivedAt: new Date('2026-10-22T08:00:00Z'),
    settledAt: new Date('2026-10-22T08:00:08Z'),
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
      createdAt: new Date('2026-10-22T09:00:00Z'),
    })),
  });
  time = today + 4999;
  expect(
    (await adapter.getInstance().inject('/stats')).json().settledCount,
  ).toBe(0);
  time = today + 5000;
  expect((await adapter.getInstance().inject('/stats')).json()).toEqual({
    settledCount: 1,
    averageTimeToSettleMs: 8000,
    duplicatesSkipped: 1,
    failuresRecovered: 1,
  });
});
const settle = async (
  settledAt: string,
  source?: 'schedule' | 'visitor',
  seconds = 10,
) => {
  const order = source
    ? await database.db.order.create({
        data: {
          item: 'Duck',
          price: 14000000n,
          expectedAmount: 14000731n,
          source,
          expiresAt: new Date(),
          signedTransaction: 'x',
        },
      })
    : undefined;
  const settled = new Date(settledAt);
  const row = await payment({
    orderId: order?.id,
    receivedAt: new Date(settled.getTime() - seconds * 1000),
    settledAt: settled,
    stage: 'notified',
  });
  await database.db.ledgerEntry.create({
    data: { paymentId: row.id, amount: row.amount },
  });
};
it('counts only today in /stats', async () => {
  await settle('2026-10-21T23:59:59Z', 'visitor');
  await settle('2026-10-22T00:00:00Z', 'visitor', 4);
  await settle('2026-10-22T11:00:00Z', 'schedule', 8);
  await database.db.incident.createMany({
    data: (
      [
        ['duplicate', '2026-10-21T23:59:59Z'],
        ['duplicate', '2026-10-22T01:00:00Z'],
        ['gap_recovered', '2026-10-21T10:00:00Z'],
      ] as const
    ).map(([kind, at]) => ({
      kind,
      whatHappened: kind,
      howHandled: 'Handled',
      createdAt: new Date(at),
    })),
  });
  expect((await adapter.getInstance().inject('/stats')).json()).toEqual({
    settledCount: 2,
    averageTimeToSettleMs: 6000,
    duplicatesSkipped: 1,
    failuresRecovered: 0,
  });
});
it('returns 30 zero-filled days in /stats/daily with scheduled and visitor split', async () => {
  await settle('2026-10-22T11:00:00Z', 'schedule', 8);
  await settle('2026-10-22T11:30:00Z', 'visitor', 4);
  await settle('2026-10-20T11:30:00Z', 'visitor', 10);
  await settle('2026-09-23T00:00:00Z');
  await settle('2026-09-22T23:59:59Z', 'visitor');
  const response = await adapter.getInstance().inject('/stats/daily');
  const days = response.json();
  expect(days).toHaveLength(30);
  expect(days[0]).toEqual({
    day: '2026-09-23',
    settled: 1,
    scheduled: 0,
    visitor: 0,
    averageTimeToSettleMs: 10000,
  });
  expect(days[29]).toEqual({
    day: '2026-10-22',
    settled: 2,
    scheduled: 1,
    visitor: 1,
    averageTimeToSettleMs: 6000,
  });
  expect(days[27]).toEqual({
    day: '2026-10-20',
    settled: 1,
    scheduled: 0,
    visitor: 1,
    averageTimeToSettleMs: 10000,
  });
  expect(days[28]).toEqual({
    day: '2026-10-21',
    settled: 0,
    scheduled: 0,
    visitor: 0,
    averageTimeToSettleMs: null,
  });
  await settle('2026-10-22T11:45:00Z', 'visitor');
  time = today + 59999;
  expect(
    (await adapter.getInstance().inject('/stats/daily')).json()[29].settled,
  ).toBe(2);
  time = today + 60000;
  expect(
    (await adapter.getInstance().inject('/stats/daily')).json()[29].settled,
  ).toBe(3);
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
    confirmations: 7,
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
it('reports monitoring timestamps in /health', async () => {
  expect(
    (await adapter.getInstance().inject('/health')).json().monitoring,
  ).toEqual({
    cursorAdvancedAt: null,
    oldestUnsettledAt: null,
    oldestUnnotifiedAt: null,
    lastScheduledPurchaseAt: null,
    visitorPausedSince: null,
  });
  await database.db.cursor.create({
    data: {
      name: `chain-${config.CHAIN_ID}-${config.SHOP_ADDRESS.toLowerCase()}`,
      blockNumber: 92n,
      blockHash: '0x01',
    },
  });
  await database.db.cursor.updateMany({
    data: { blockNumber: 93n, updatedAt: new Date('2026-10-22T10:00:00Z') },
  });
  await payment({
    stage: 'confirming',
    receivedAt: new Date('2026-10-22T09:00:00Z'),
  });
  await payment({
    stage: 'sent',
    receivedAt: null,
    sentAt: new Date('2026-10-22T08:00:00Z'),
  });
  await payment({
    stage: 'notified',
    receivedAt: new Date('2026-10-21T01:00:00Z'),
    settledAt: new Date('2026-10-21T01:00:05Z'),
  });
  await payment({
    stage: 'settled',
    settledAt: new Date('2026-10-22T07:30:00Z'),
  });
  await payment({
    stage: 'settled',
    settledAt: new Date('2026-10-22T06:30:00Z'),
  });
  for (const [source, at] of [
    ['schedule', '2026-10-21T05:00:00Z'],
    ['schedule', '2026-10-22T05:00:00Z'],
    ['visitor', '2026-10-22T06:00:00Z'],
  ] as const)
    await database.db.order.create({
      data: {
        item: 'Duck',
        price: 1n,
        expectedAmount: 1n,
        source,
        expiresAt: new Date(),
        signedTransaction: 'x',
        createdAt: new Date(at),
      },
    });
  await redis.set(
    'visitor-paused-since',
    String(Date.parse('2026-10-21T00:00:00Z')),
  );
  try {
    expect(
      (await adapter.getInstance().inject('/health')).json().monitoring,
    ).toEqual({
      cursorAdvancedAt: '2026-10-22T10:00:00.000Z',
      oldestUnsettledAt: '2026-10-22T08:00:00.000Z',
      oldestUnnotifiedAt: '2026-10-22T06:30:00.000Z',
      lastScheduledPurchaseAt: '2026-10-22T05:00:00.000Z',
      visitorPausedSince: '2026-10-21T00:00:00.000Z',
    });
  } finally {
    await redis.del('visitor-paused-since');
  }
});
