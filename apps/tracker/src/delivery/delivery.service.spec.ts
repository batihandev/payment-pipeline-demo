import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { orderChannel } from '@app/events/order-events';
import { paymentChannel } from '@app/events/publish-payment';
import { closeOrder } from '@app/orders/close-order';
import {
  fixture,
  clear,
  TrackerChain,
  log,
  now,
  trackerConfig,
  order,
} from '../../testing/fixtures';
import { ScannerService } from '../scanning/scanner.service';
import { ProgressService } from '../scanning/progress.service';
import { DeliveryService } from './delivery.service';
import { testRedisUrl } from '@testing/config/redis';
let f: Awaited<ReturnType<typeof fixture>>;
let redis: Redis;
let queue: Queue<{ paymentId: string }>;
let scanner: ScannerService;
let progress: ProgressService;
beforeAll(async () => {
  f = await fixture();
  redis = new Redis(testRedisUrl());
  queue = new Queue(`notices-test-${randomUUID()}`, {
    connection: { url: testRedisUrl() },
  });
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
  await f.close();
});
beforeEach(async () => {
  await clear(f.db);
  await queue.obliterate({ force: true });
  f.chain = new TrackerChain();
  f.chain.logs = [log()];
  scanner = new ScannerService(f.db, f.chain, trackerConfig(), () => now);
  progress = new ProgressService(f.db, scanner, () => now);
});
it('saves full payment snapshots for every stage change and finality without duplicate events on rescan', async () => {
  await order(f.db);
  await scanner.scanOnce();
  await scanner.scanOnce();
  await progress.advance(19n, 0n);
  await progress.advance(20n, 0n);
  await progress.advance(20n, 10n);
  const events = await f.db.paymentEvent.findMany({ orderBy: { id: 'asc' } });
  const bodies = events.map(
    (event) => JSON.parse(event.body) as Record<string, unknown>,
  );
  expect(bodies.map((body) => [body.stage, body.final])).toEqual([
    ['received', false],
    ['confirming', false],
    ['confirming', false],
    ['settled', false],
    ['settled', true],
  ]);
  expect(bodies[0]).toMatchObject({
    amount: '100',
    blockNumber: '10',
    transactionHash: log().txHash,
  });
  expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(
    [
      ...Object.keys(await f.db.payment.findFirstOrThrow()).filter(
        (key) => key !== 'fromAddress' && key !== 'reconciledAt',
      ),
      'donorName',
      'order',
    ].sort(),
  );
});
it('publishes persisted events over Redis and marks each published snapshot', async () => {
  await order(f.db);
  await scanner.scanOnce();
  const subscriber = new Redis(testRedisUrl());
  try {
    await subscriber.subscribe(paymentChannel);
    const received = new Promise<string>((resolve) =>
      subscriber.once('message', (_channel, body: string) => {
        resolve(body);
      }),
    );
    await new DeliveryService(f.db, redis, queue, () => now).flush();
    expect((await f.db.paymentEvent.findFirstOrThrow()).publishedAt).toEqual(
      now,
    );
    expect(JSON.parse(await received)).toMatchObject({
      stage: 'received',
      amount: '100',
    });
  } finally {
    await subscriber.quit();
  }
});
it('retains an event through publication failure and delivers it after restart', async () => {
  await scanner.scanOnce();
  f.chain.logs = [log(19n)];
  await scanner.scanOnce();
  const unavailable = {
    publish: () => {
      return Promise.reject(new Error('unavailable'));
    },
  };
  await expect(
    new DeliveryService(f.db, unavailable, queue, () => now).flush(),
  ).rejects.toThrow();
  expect((await f.db.paymentEvent.findFirstOrThrow()).publishedAt).toBeNull();
  await new DeliveryService(f.db, redis, queue, () => now).flush();
  expect((await f.db.paymentEvent.findFirstOrThrow()).publishedAt).toEqual(now);
  expect(await f.db.incident.count({ where: { kind: 'event_failed' } })).toBe(
    1,
  );
});
it('queues one durable notice per settled payment with bounded exponential retries', async () => {
  await order(f.db);
  await scanner.scanOnce();
  await progress.advance(20n);
  expect(await f.db.notice.count()).toBe(1);
  const delivery = new DeliveryService(f.db, redis, queue, () => now);
  await delivery.flush();
  await delivery.flush();
  const jobs = await queue.getJobs(['waiting', 'delayed']);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.data).toEqual({
    paymentId: (await f.db.payment.findFirstOrThrow()).id,
  });
  expect(jobs[0]?.opts).toMatchObject({
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  });
});
it('rolls back stage events and the notice if credit cannot be inserted', async () => {
  await order(f.db);
  await scanner.scanOnce();
  await f.db.$executeRawUnsafe(
    'ALTER TABLE ledger_entries ADD CONSTRAINT reject_credit CHECK (amount < 0)',
  );
  try {
    await expect(progress.advance(20n)).rejects.toThrow();
    expect(await f.db.paymentEvent.count()).toBe(1);
    expect(await f.db.notice.count()).toBe(0);
  } finally {
    await f.db.$executeRawUnsafe(
      'ALTER TABLE ledger_entries DROP CONSTRAINT reject_credit',
    );
  }
});
it('does not restart an exhausted notice after queue data is lost', async () => {
  await order(f.db);
  await scanner.scanOnce();
  await progress.advance(20n);
  await f.db.notice.updateMany({ data: { attempts: 5 } });
  await new DeliveryService(f.db, redis, queue, () => now).flush();
  expect(await queue.getJobs(['waiting', 'delayed'])).toHaveLength(0);
});
it('publishes an order event when an order closes', async () => {
  const closing = await order(f.db);
  await f.db.$transaction((tx) => closeOrder(tx, closing));
  const subscriber = new Redis(testRedisUrl());
  try {
    await subscriber.subscribe(orderChannel);
    const received = new Promise<string>((resolve) =>
      subscriber.once('message', (_channel, body: string) => {
        resolve(body);
      }),
    );
    await new DeliveryService(f.db, redis, queue, () => now).flush();
    expect(JSON.parse(await received)).toEqual({
      type: 'order',
      id: closing.id,
      closed: true,
    });
    expect(await f.db.orderEvent.count({ where: { publishedAt: now } })).toBe(
      1,
    );
  } finally {
    await subscriber.quit();
  }
});
