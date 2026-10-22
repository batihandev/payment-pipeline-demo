import { randomUUID } from 'node:crypto';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { testDatabase } from '../../../libs/db/testing/database';
import { Purchases } from '../../buyer/src/purchases';
import { BuyerJobs, type BuyerJobData } from '../../buyer/src/jobs';
import { registerTestPurchases } from './test-purchases';
import { testRedisUrl } from '../../../libs/config/testing/redis';
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let queue: Queue<BuyerJobData>;
let adapter: FastifyAdapter;
let prefix: string;
let purchases: Purchases;
const now = new Date('2026-10-20T12:00:00Z');
beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis(testRedisUrl());
  queue = new Queue(`api-visitors-${randomUUID()}`, {
    connection: { url: testRedisUrl() },
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
    'TRUNCATE payments, orders, daily_budgets CASCADE',
  );
  await queue.drain(true);
  prefix = `api-limit-test:${randomUUID()}`;
  purchases = new Purchases(
    database.db,
    {
      cap: { count: 20, amount: 1000000000n },
      seed: '84532',
      ttlMinutes: 30,
      quietStart: 0,
      quietEnd: 7,
    },
    () => 0,
  );
  adapter = new FastifyAdapter();
  registerTestPurchases(
    adapter.getInstance(),
    redis,
    purchases,
    new BuyerJobs(database.db, purchases, queue),
    { prefix, now: () => now },
  );
});
afterEach(async () => {
  await adapter.close();
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length) await redis.del(...keys);
});
const buy = (ip = '127.0.0.1') =>
  adapter
    .getInstance()
    .inject({ method: 'POST', url: '/test-purchases', remoteAddress: ip });
async function expireCooldown() {
  await redis.pexpire(`${prefix}:cooldown`, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
it('returns an order id, reserves the shared budget and queues an immediate priority-one visitor job', async () => {
  const response = await buy();
  expect(response.statusCode).toBe(202);
  const { orderId } = response.json();
  expect(orderId).toEqual(expect.any(String));
  const order = await database.db.order.findUniqueOrThrow({
    where: { id: orderId },
  });
  expect(order.source).toBe('visitor');
  const budget = await database.db.dailyBudget.findFirstOrThrow();
  expect(budget.reservedCount).toBe(1);
  expect(budget.reservedAmount).toBe(order.expectedAmount);
  const job = await queue.getJob(`visitor-${orderId}`);
  expect(job?.name).toBe('visitor-purchase');
  expect(job?.opts).toMatchObject({ priority: 1, delay: 0 });
  const retry = await purchases.visitor(orderId, now);
  expect(retry?.id).toBe(orderId);
  expect((await database.db.dailyBudget.findFirstOrThrow()).reservedCount).toBe(
    1,
  );
});
it('refuses a spent budget without creating an order or a send job', async () => {
  const budget = await purchases.ensureBudget(now);
  await database.db.dailyBudget.update({
    where: { day: budget.day },
    data: {
      reservedCount: budget.targetCount,
      reservedAmount: budget.targetAmount,
    },
  });
  const response = await buy();
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: 'budget_spent' });
  expect(await database.db.order.count()).toBe(0);
  expect(await queue.getWaitingCount()).toBe(0);
  expect(await queue.getPrioritizedCount()).toBe(0);
});
it('allows one simultaneous request across different IPs during the global cooldown', async () => {
  const responses = await Promise.all([buy('192.0.2.1'), buy('192.0.2.2')]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([
    202, 429,
  ]);
  const denied = responses.find((response) => response.statusCode === 429);
  expect(denied?.json().error).toBe('cooldown');
  expect(Number(denied?.headers['retry-after'])).toBeGreaterThan(0);
  expect(await database.db.order.count()).toBe(1);
});
it('limits each IP to three admitted requests per ten-minute window', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    expect((await buy()).statusCode).toBe(202);
    await expireCooldown();
  }
  const denied = await buy();
  expect(denied.statusCode).toBe(429);
  expect(denied.json().error).toBe('rate_limited');
  expect(Number(denied.headers['retry-after'])).toBeGreaterThan(500);
  expect((await buy('192.0.2.3')).statusCode).toBe(202);
  expect(await database.db.order.count()).toBe(4);
});
it('allows a new request after the IP window and global cooldown expire', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await buy();
    await expireCooldown();
  }
  const keys = await redis.keys(`${prefix}:ip:*`);
  for (const key of keys) await redis.pexpire(key, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await buy()).statusCode).toBe(202);
});
