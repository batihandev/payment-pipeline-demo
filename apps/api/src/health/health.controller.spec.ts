import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import request from 'supertest';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import {
  cooldownKey,
  serviceLimiter,
} from '../../../../libs/chain/src/service-limiter';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import { payment as createPayment, useReadApi } from '../../testing/read-api';
import { ChainSnapshotService } from './chain-snapshot.service';

const state = useReadApi();
const get = (url: string) => request(state.app.getHttpServer()).get(url);
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
    limiter.run(async () => {
      throw new RpcError('rate_limit');
    }),
  ).rejects.toThrow();
  const cooling = (await get('/health')).body;
  expect(cooling.cooldowns.tracker).toBeGreaterThan(0);
  await state.redis.pexpire(cooldownKey('tracker'), 1);
  while (await state.redis.exists(cooldownKey('tracker')))
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await get('/health')).body.cooldowns.tracker).toBe(0);
});
it('reports an unknown cursor and lag before the tracker initializes', async () => {
  expect((await get('/health')).body).toMatchObject({
    cursor: null,
    lag: null,
    openGaps: 0,
  });
});
it('reports monitoring timestamps in /health', async () => {
  expect((await get('/health')).body.monitoring).toEqual({
    cursorAdvancedAt: null,
    oldestUnsettledAt: null,
    oldestUnnotifiedAt: null,
    lastScheduledPurchaseAt: null,
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
    expect((await get('/health')).body.monitoring).toEqual({
      cursorAdvancedAt: '2026-10-22T10:00:00.000Z',
      oldestUnsettledAt: '2026-10-22T08:00:00.000Z',
      oldestUnnotifiedAt: '2026-10-22T06:30:00.000Z',
      lastScheduledPurchaseAt: '2026-10-22T05:00:00.000Z',
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
  expect((await get('/health')).body.monitoring.oldestUnnotifiedAt).toBeNull();
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
  const before = (await get('/health')).body;
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
    monitoring: expect.objectContaining({ oldestUnsettledAt: null }),
  });
});
it('still answers /health with null Redis parts while Redis is down', async () => {
  const down = jest.fn().mockRejectedValue(new Error('connection refused'));
  const redis = state.redisOf();
  jest.spyOn(redis, 'pttl').mockImplementation(down);
  jest.spyOn(redis, 'get').mockImplementation(down);
  const response = await get('/health');
  expect(response.statusCode).toBe(200);
  expect(response.body).toMatchObject({
    head: '100',
    queueDepth: null,
    cooldowns: null,
    redisError: 'unavailable',
    monitoring: expect.objectContaining({ visitorPausedSince: null }),
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
  expect((await get('/health')).body.monitoring.oldestUnsettledAt).toBe(
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
  expect((await get('/health')).body.monitoring.oldestUnsettledAt).toBeNull();
});
