import { randomUUID } from 'node:crypto';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { testDatabase } from '../../../libs/db/testing/database';
import { Purchases } from '../../buyer/src/purchases';
import { BuyerJobs, type BuyerJobData } from '../../buyer/src/jobs';
import {
  recordGasPause,
  registerTestPurchases,
  type GasReading,
  type VisitorLimits,
} from './test-purchases';
import { proxyTrust } from './proxy';
import { testRedisUrl } from '../../../libs/config/testing/redis';
import { ChainSnapshot, buyerGas } from './chain-snapshot';
jest.setTimeout(120000);
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let queue: Queue<BuyerJobData>;
let adapter: FastifyAdapter;
let prefix: string;
let purchases: Purchases;
let limits: VisitorLimits;
let gas: GasReading;
let tick: number;
function build(
  trustProxy: ReturnType<typeof proxyTrust>,
  latestBuyerGas: () => Promise<GasReading> = async () => gas,
) {
  const built = new FastifyAdapter({ trustProxy });
  registerTestPurchases(
    built.getInstance(),
    redis,
    database.db,
    purchases,
    new BuyerJobs(database.db, purchases, queue),
    {
      prefix,
      limits,
      latestBuyerGas,
      now: () => new Date(now.getTime() + tick++),
    },
  );
  return built;
}
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
  limits = {
    perMinute: 10,
    perDay: 100,
    queueLimit: 30,
    dailyLimit: 2000,
    gasFloor: 200000000000000n,
  };
  gas = null;
  tick = 0;
  adapter = build(proxyTrust(false));
});
afterEach(async () => {
  await adapter.close();
  await redis.del('visitor-paused-since');
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length) await redis.del(...keys);
});
const buy = (ip = '127.0.0.1', headers: Record<string, string> = {}) =>
  adapter.getInstance().inject({
    method: 'POST',
    url: '/test-purchases',
    remoteAddress: ip,
    headers,
  });
const seedPending = async (count: number) => {
  for (let index = 0; index < count; index++)
    await database.db.order.create({
      data: {
        item: 'x',
        price: 1n,
        expectedAmount: BigInt(index + 1),
        source: 'visitor',
        createdAt: new Date(now.getTime() - 1000 + index),
        expiresAt: new Date(now.getTime() + 60000),
      },
    });
};

it('queues an immediate priority-one visitor job without taking scheduled budget', async () => {
  const response = await buy();
  expect(response.statusCode).toBe(202);
  const { orderId, position } = response.json();
  expect(position).toBe(1);
  const order = await database.db.order.findUniqueOrThrow({
    where: { id: orderId },
  });
  expect(order.source).toBe('visitor');
  const budget = await database.db.dailyBudget.findFirstOrThrow();
  expect(budget.reservedCount).toBe(0);
  const job = await queue.getJob(`visitor-${orderId}`);
  expect(job?.name).toBe('visitor-purchase');
  expect(job?.opts).toMatchObject({ priority: 1, delay: 0 });
});

it('admits back-to-back clicks from different visitors', async () => {
  const first = await buy('192.0.2.1');
  const second = await buy('192.0.2.2');
  expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
  expect(second.json().position).toBe(2);
});

it('limits one visitor to 10 a minute', async () => {
  for (let attempt = 0; attempt < 10; attempt++)
    expect((await buy()).statusCode).toBe(202);
  const denied = await buy();
  expect(denied.statusCode).toBe(429);
  expect(denied.json()).toEqual({ error: 'rate_limited' });
  expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
  expect((await buy('192.0.2.9')).statusCode).toBe(202);
});

it('limits one visitor to their per-day limit until the UTC day ends', async () => {
  limits.perMinute = 1000;
  limits.perDay = 2;
  limits.queueLimit = 1000;
  await buy();
  await buy();
  const denied = await buy();
  expect(denied.statusCode).toBe(429);
  expect(denied.json()).toEqual({ error: 'rate_limited' });
  expect(Number(denied.headers['retry-after'])).toBeGreaterThan(3600);
});

it('returns busy when 30 visitor purchases wait', async () => {
  await seedPending(30);
  const response = await buy();
  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual({ error: 'busy' });
  expect(response.headers['retry-after']).toBe('2');
  expect(await database.db.order.count()).toBe(30);
});

it('accepts 30 of 40 burst clicks in order', async () => {
  const responses = await Promise.all(
    Array.from({ length: 40 }, (_, index) => buy(`192.0.2.${index + 1}`)),
  );
  const accepted = responses.filter((response) => response.statusCode === 202);
  const busy = responses.filter((response) => response.statusCode === 429);
  expect(accepted).toHaveLength(30);
  expect(busy).toHaveLength(10);
  expect(busy.every((response) => response.json().error === 'busy')).toBe(true);
  expect(accepted.map((response) => response.json().position)).toEqual(
    Array.from({ length: 30 }, (_, index) => index + 1),
  );
});

it('refuses past the visitor daily limit', async () => {
  limits.dailyLimit = 2;
  await buy('192.0.2.1');
  await buy('192.0.2.2');
  const response = await buy('192.0.2.3');
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: 'daily_limit' });
  expect(await database.db.order.count()).toBe(2);
});

it('pauses below the gas floor', async () => {
  gas = { native: limits.gasFloor - 1n, at: now.getTime() };
  const paused = await buy();
  expect(paused.statusCode).toBe(503);
  expect(paused.json()).toEqual({ error: 'paused' });
  expect(await database.db.order.count()).toBe(0);
  gas = { native: limits.gasFloor, at: now.getTime() };
  expect((await buy()).statusCode).toBe(202);
});

it('records the gas-floor pause on each chain refresh, without visitor clicks', async () => {
  let native = limits.gasFloor - 1n;
  let time = now.getTime();
  const snapshot = new ChainSnapshot(
    {
      getHead: async () => ({ number: 1n, hash: '0x01' }),
      getBalances: async () => ({ native, usdc: 0n }),
    },
    { buyer: `0x${'11'.repeat(20)}`, shop: `0x${'22'.repeat(20)}` },
    {
      now: () => time,
      onRefresh: recordGasPause(redis, limits.gasFloor, () => time),
    },
  );
  await snapshot.refresh();
  expect(await redis.get('visitor-paused-since')).toBe(String(now.getTime()));
  time += 10000;
  await snapshot.refresh();
  expect(await redis.get('visitor-paused-since')).toBe(String(now.getTime()));
  native = limits.gasFloor;
  time += 10000;
  await snapshot.refresh();
  expect(await redis.get('visitor-paused-since')).toBeNull();
});

it('admits when the gas reading is missing or stale', async () => {
  gas = null;
  expect((await buy('192.0.2.1')).statusCode).toBe(202);
  gas = { native: 0n, at: now.getTime() - 5 * 60 * 1000 - 1000 };
  expect((await buy('192.0.2.2')).statusCode).toBe(202);
});

it('reports queue position', async () => {
  const first = (await buy('192.0.2.1')).json();
  const second = (await buy('192.0.2.2')).json();
  const position = async (id: string) =>
    (
      await adapter.getInstance().inject({
        method: 'GET',
        url: `/test-purchases/${id}`,
      })
    ).json();
  expect(await position(first.orderId)).toEqual({ position: 1 });
  expect(await position(second.orderId)).toEqual({ position: 2 });
  await database.db.order.update({
    where: { id: second.orderId },
    data: { sendState: 'sent' },
  });
  expect(await position(second.orderId)).toEqual({ position: 0 });
  expect(await position(randomUUID())).toEqual({ position: 0 });
  expect(await position('not-an-id')).toEqual({ position: 0 });
});

it('uses the forwarded client address when TRUST_PROXY is on', async () => {
  await adapter.close();
  adapter = build(proxyTrust(true));
  limits.perMinute = 1;
  const first = await buy('10.0.0.1', { 'x-forwarded-for': '198.51.100.1' });
  const second = await buy('10.0.0.1', { 'x-forwarded-for': '198.51.100.2' });
  const repeat = await buy('10.0.0.1', { 'x-forwarded-for': '198.51.100.1' });
  expect([first.statusCode, second.statusCode, repeat.statusCode]).toEqual([
    202, 202, 429,
  ]);
});

it('trusts only the nearest proxy, so a forged leftmost address does not help', async () => {
  await adapter.close();
  adapter = build(proxyTrust(true));
  limits.perMinute = 1;
  const first = await buy('10.0.0.1', {
    'x-forwarded-for': '6.6.6.6, 1.1.1.1',
  });
  const forged = await buy('10.0.0.1', {
    'x-forwarded-for': '7.7.7.7, 1.1.1.1',
  });
  expect([first.statusCode, forged.statusCode]).toEqual([202, 429]);
});

it('ignores expired orders when checking the queue and counting position', async () => {
  await seedPending(30);
  await database.db.order.updateMany({
    where: { expectedAmount: { lte: 5n } },
    data: { status: 'expired' },
  });
  const response = await buy();
  expect(response.statusCode).toBe(202);
  expect(response.json().position).toBe(26);
});

it('admits from a fresh chain snapshot without an RPC call', async () => {
  const calls: string[] = [];
  const snapshot = new ChainSnapshot(
    {
      getHead: async () => {
        calls.push('getHead');
        return { number: 1n, hash: '0x01' };
      },
      getBalances: async () => {
        calls.push('getBalances');
        return { native: limits.gasFloor - 1n, usdc: 0n };
      },
    },
    { buyer: `0x${'11'.repeat(20)}`, shop: `0x${'22'.repeat(20)}` },
    { now: () => now.getTime() },
  );
  await snapshot.refresh();
  const before = calls.length;
  await adapter.close();
  adapter = build(proxyTrust(false), buyerGas(snapshot));
  const response = await buy();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ error: 'paused' });
  expect(calls).toHaveLength(before);
});

it('admits without waiting on a chain read that has not finished', async () => {
  const snapshot = new ChainSnapshot(
    {
      getHead: () => new Promise<never>(() => {}),
      getBalances: () => new Promise<never>(() => {}),
    },
    { buyer: `0x${'11'.repeat(20)}`, shop: `0x${'22'.repeat(20)}` },
  );
  await adapter.close();
  adapter = build(proxyTrust(false), buyerGas(snapshot));
  expect((await buy('192.0.2.1')).statusCode).toBe(202);
  expect((await buy('192.0.2.2')).statusCode).toBe(202);
});

it('gives orders created in the same millisecond distinct positions', async () => {
  const createdAt = new Date(now.getTime() - 1000);
  const rows = [];
  for (const expectedAmount of [1n, 2n, 3n])
    rows.push(
      await database.db.order.create({
        data: {
          item: 'x',
          price: 1n,
          expectedAmount,
          source: 'visitor',
          createdAt,
          expiresAt: new Date(now.getTime() + 60000),
        },
      }),
    );
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const positions = [];
  for (const row of rows)
    positions.push(
      (
        await adapter.getInstance().inject({
          method: 'GET',
          url: `/test-purchases/${row.id}`,
        })
      ).json().position,
    );
  expect(positions).toEqual([1, 2, 3]);
  expect((await buy()).json().position).toBe(4);
});
