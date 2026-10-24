import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import request from 'supertest';
import { RpcError } from '@app/chain/rpc-error';
import { cooldownKey, serviceLimiter } from '@app/chain/service-limiter';
import { testRedisUrl } from '@testing/config/redis';
import { payment as createPayment, useReadApi } from '../../testing/read-api';
import { ChainSnapshotService } from './chain-snapshot.service';

const state = useReadApi();
const get = (url: string) => request(state.app.getHttpServer()).get(url);
const at = z.string().nullable();
/** The /health fields these tests read; monitoring is checked whole. */
const healthRead = z.object({
  cardAvailable: z.boolean(),
  cooldowns: z.record(z.string(), z.number()).nullable(),
  monitoring: z.strictObject({
    cursorAdvancedAt: at,
    oldestUnsettledAt: at,
    oldestUnnotifiedAt: at,
    lastScheduledPurchaseAt: at,
    lastCardSettledAt: at,
    visitorPausedSince: at,
  }),
});
const health = async () => healthRead.parse((await get('/health')).body);
const payment = (data = {}) => createPayment(state, data);
it('reports head, scoped cursor lag, open gaps, queued work and live balance warnings', async () => {
  await state.database.db.cursor.create({
    data: {
      name: `chain-84532-0x${'22'.repeat(20)}`,
      blockNumber: 92n,
      blockHash: '0x01',
    },
  });
  await state.database.db.scanGap.create({
    data: {
      fromBlock: 1n,
      toBlock: 5n,
      errorCategory: 'timeout',
      nextRetryAt: new Date(),
    },
  });
  const queue = new Queue('buyer', {
    connection: { url: testRedisUrl() },
    prefix: state.queuePrefix,
  });
  await queue.add(
    'visitor-purchase',
    { orderId: randomUUID() },
    { priority: 1 },
  );
  const response = await get('/health');
  expect(response.statusCode).toBe(200);
  expect(response.body).toMatchObject({
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
    cooldowns: { buyer: 0, tracker: 0, api: 0, stripe: 0 },
  });
  await queue.obliterate({ force: true });
  await queue.close();
});

it('reports an actual rate-limit cooldown and its expiry from live Redis state', async () => {
  // A long cooldown keeps the first read inside it however slow the database answers.
  const limiter = serviceLimiter(state.redis, 'tracker', 5, 60000);
  await expect(
    limiter.run(() => {
      return Promise.reject(new RpcError('rate_limit'));
    }),
  ).rejects.toThrow();
  expect((await health()).cooldowns?.tracker).toBeGreaterThan(0);
  await state.redis.pexpire(cooldownKey('tracker'), 1);
  while (await state.redis.exists(cooldownKey('tracker')))
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await health()).cooldowns?.tracker).toBe(0);
});
it('reports an unknown cursor and lag before the tracker initializes', async () => {
  expect((await get('/health')).body).toMatchObject({
    cursor: null,
    lag: null,
    openGaps: 0,
  });
});
const savedCard = {
  name: 'Demo customer',
  stripeCustomerId: 'cus_health',
  stripePaymentMethodId: 'pm_health',
  cardBrand: 'visa',
  cardLast4: '4242',
};
it('reports the card rail available once the demo customer has a saved card', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_health';
  await state.rebuild();
  await state.database.db.customer.deleteMany();
  expect((await health()).cardAvailable).toBe(false);
  await state.database.db.customer.create({ data: savedCard });
  expect((await health()).cardAvailable).toBe(true);
  await state.database.db.customer.deleteMany();
});
it('reports the card rail unavailable without a webhook secret', async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await state.rebuild();
  await state.database.db.customer.create({ data: savedCard });
  expect((await health()).cardAvailable).toBe(false);
  await state.database.db.customer.deleteMany();
});
it('reports monitoring timestamps in /health', async () => {
  expect((await health()).monitoring).toEqual({
    cursorAdvancedAt: null,
    oldestUnsettledAt: null,
    oldestUnnotifiedAt: null,
    lastScheduledPurchaseAt: null,
    lastCardSettledAt: null,
    visitorPausedSince: null,
  });
  await state.database.db.cursor.create({
    data: {
      name: `chain-84532-0x${'22'.repeat(20)}`,
      blockNumber: 92n,
      blockHash: '0x01',
    },
  });
  await state.database.db.cursor.updateMany({
    data: { blockNumber: 93n, advancedAt: new Date('2026-10-22T10:00:00Z') },
  });
  const matched = await state.database.db.order.create({
    data: {
      item: 'Duck',
      price: 1n,
      expectedAmount: 2n,
      source: 'visitor',
      expiresAt: new Date(),
      signedTransaction: 'x',
      createdAt: new Date('2026-10-22T07:59:00Z'),
    },
  });
  await payment({
    orderId: matched.id,
    stage: 'confirming',
    receivedAt: new Date('2026-10-22T09:00:00Z'),
  });
  await payment({
    orderId: matched.id,
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
    await state.database.db.order.create({
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
  await state.redis.set(
    'visitor-paused-since',
    String(Date.parse('2026-10-21T00:00:00Z')),
  );
  try {
    expect((await health()).monitoring).toEqual({
      cursorAdvancedAt: '2026-10-22T10:00:00.000Z',
      oldestUnsettledAt: '2026-10-22T08:00:00.000Z',
      oldestUnnotifiedAt: '2026-10-22T06:30:00.000Z',
      lastScheduledPurchaseAt: '2026-10-22T05:00:00.000Z',
      lastCardSettledAt: null,
      visitorPausedSince: '2026-10-21T00:00:00.000Z',
    });
  } finally {
    await state.redis.del('visitor-paused-since');
  }
});
it('leaves settled donations out of the unnotified signal', async () => {
  await payment({
    donation: true,
    stage: 'settled',
    settledAt: new Date('2026-10-01T00:00:00Z'),
  });
  expect((await health()).monitoring.oldestUnnotifiedAt).toBeNull();
});
it('reports when the newest card payment settled, leaving network payments out', async () => {
  for (const [key, settledAt] of [
    ['pi_older', '2026-10-22T07:00:00Z'],
    ['pi_newer', '2026-10-22T09:00:00Z'],
  ] as const)
    await payment({
      provider: 'stripe',
      externalKey: key,
      transactionHash: null,
      stage: 'notified',
      settledAt: new Date(settledAt),
    });
  await payment({
    stage: 'notified',
    settledAt: new Date('2026-10-22T10:00:00Z'),
  });
  expect((await health()).monitoring.lastCardSettledAt).toBe(
    '2026-10-22T09:00:00.000Z',
  );
});
it('reports a processing card payment as unsettled', async () => {
  const order = await state.database.db.order.create({
    data: {
      item: 'Duck',
      price: 500000n,
      expectedAmount: 500000n,
      source: 'visitor',
      rail: 'card',
      sendState: 'sent',
      expiresAt: new Date(),
    },
  });
  await payment({
    provider: 'stripe',
    orderId: order.id,
    stage: 'processing',
    receivedAt: null,
    sentAt: new Date('2026-10-22T08:00:00Z'),
    processingAt: new Date('2026-10-22T08:00:01Z'),
  });
  expect((await health()).monitoring.oldestUnsettledAt).toBe(
    '2026-10-22T08:00:01.000Z',
  );
});
it('answers /health from a fresh chain snapshot without RPC calls', async () => {
  const calls = state.chainCalls.length;
  const response = await get('/health');
  expect(response.statusCode).toBe(200);
  expect(response.body).toMatchObject({ head: '100', chainError: null });
  expect(state.chainCalls).toHaveLength(calls);
});
it('returns monitoring with null chain fields when the chain read fails', async () => {
  state.headFailure = new RpcError('timeout');
  await state.rebuild(false);
  const before: unknown = (await get('/health')).body;
  expect(before).toMatchObject({
    head: null,
    lag: null,
    balances: null,
    chainError: 'not_loaded',
    openGaps: 0,
  });
  await state.app.get(ChainSnapshotService).refresh();
  const response = await get('/health');
  expect(response.statusCode).toBe(200);
  expect(response.body).toMatchObject({
    confirmations: 7,
    head: null,
    lag: null,
    balances: null,
    chainError: 'timeout',
    openGaps: 0,
    cooldowns: { buyer: 0, tracker: 0, api: 0, stripe: 0 },
    monitoring: expect.objectContaining({ oldestUnsettledAt: null }) as unknown,
  });
});
it('still answers /health with null Redis parts while Redis is down', async () => {
  const down = vi.fn().mockRejectedValue(new Error('connection refused'));
  const redis = state.redisOf();
  vi.spyOn(redis, 'pttl').mockImplementation(down);
  vi.spyOn(redis, 'get').mockImplementation(down);
  const response = await get('/health');
  expect(response.statusCode).toBe(200);
  expect(response.body).toMatchObject({
    head: '100',
    queueDepth: null,
    cooldowns: null,
    redisError: 'unavailable',
    monitoring: expect.objectContaining({
      visitorPausedSince: null,
    }) as unknown,
  });
});
it('leaves unmatched payments out of the oldest unsettled payment', async () => {
  await payment({
    stage: 'received',
    receivedAt: new Date('2026-10-01T00:00:00Z'),
  });
  const order = await state.database.db.order.create({
    data: {
      item: 'Duck',
      price: 1n,
      expectedAmount: 1n,
      source: 'visitor',
      expiresAt: new Date(),
      signedTransaction: 'x',
    },
  });
  await payment({
    orderId: order.id,
    stage: 'received',
    receivedAt: new Date('2026-10-22T09:00:00Z'),
  });
  expect((await health()).monitoring.oldestUnsettledAt).toBe(
    '2026-10-22T09:00:00.000Z',
  );
});
it('leaves transfers closed as reverted or dropped out of the oldest unsettled payment', async () => {
  const closed = await state.database.db.order.create({
    data: {
      item: 'Duck',
      price: 1n,
      expectedAmount: 1n,
      source: 'visitor',
      status: 'expired',
      sendState: 'failed',
      expiresAt: new Date(),
      signedTransaction: 'x',
    },
  });
  await payment({
    orderId: closed.id,
    stage: 'sent',
    receivedAt: null,
    sentAt: new Date('2026-10-01T00:00:00Z'),
  });
  expect((await health()).monitoring.oldestUnsettledAt).toBeNull();
});
