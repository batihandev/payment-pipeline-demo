import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ChainClient } from '../../../../libs/chain/src/chain-client';
import { testDatabase } from '../../../../libs/db/testing/database';
import { PrismaService } from '../../../../libs/db/src';
import {
  OrderQueueService,
  CustomersService,
  PurchasesService,
} from '../../../../libs/orders/src';
import type { BuyerJobData } from '../../../../libs/queues/src';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import {
  orderChannel,
  serializeOrder,
} from '../../../../libs/events/src/order-events';
import { createTestApp } from '../../testing/app';
import { openEventStream } from '../../testing/event-stream';
import { NOW } from '../common/clock.module';
import {
  ChainSnapshotService,
  type GasReading,
} from '../health/chain-snapshot.service';
import {
  VISITOR_LIMITS,
  VISITOR_PREFIX,
  type VisitorLimits,
} from './visitor-limits';

jest.setTimeout(120000);
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let queue: Queue<BuyerJobData>;
let app: NestExpressApplication;
let prefix: string;
let purchases: PurchasesService;
let limits: VisitorLimits;
let gas: GasReading;
let tick: number;
const queuePrefix = `api-visitors-${randomUUID()}`;
const now = new Date('2026-10-20T12:00:00Z');
// Every app reads CF-Connecting-IP, so each test's visitors are told apart by that header.
async function build(
  override: (
    builder: Parameters<
      NonNullable<Parameters<typeof createTestApp>[0]>['override'] & {}
    >[0],
  ) => void = (builder) => {
    builder
      .overrideProvider(ChainSnapshotService)
      .useValue({ buyerGas: async () => gas });
  },
  clientIpHeader = 'cf-connecting-ip',
) {
  await app?.close();
  app = await createTestApp({
    environment: {
      CLIENT_IP_HEADER: clientIpHeader,
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
    },
    queuePrefix,
    override: (builder) => {
      builder
        .overrideProvider(PrismaService)
        .useValue(database.db)
        .overrideProvider(NOW)
        .useValue(() => new Date(now.getTime() + tick++))
        .overrideProvider(PurchasesService)
        .useValue(purchases)
        .overrideProvider(VISITOR_LIMITS)
        .useValue(limits)
        .overrideProvider(VISITOR_PREFIX)
        .useValue(prefix);
      override(builder);
    },
  });
}
beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis(testRedisUrl());
  queue = new Queue('buyer', {
    connection: { url: testRedisUrl() },
    prefix: queuePrefix,
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
    'TRUNCATE payments, orders, customers, daily_budgets CASCADE',
  );
  await queue.drain(true);
  prefix = `api-limit-test:${randomUUID()}`;
  purchases = new PurchasesService(
    database.db,
    {
      cap: { count: 20, amount: 1000000000n },
      seed: '84532',
      ttlMinutes: 30,
      quietStart: 0,
      quietEnd: 7,
      cardRail: true,
    },
    () => 0,
    new CustomersService(database.db),
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
  await build();
});
afterEach(async () => {
  await app.close();
  await redis.del('visitor-paused-since');
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length) await redis.del(...keys);
});
const buy = (ip = '127.0.0.1', headers: Record<string, string> = {}) =>
  request(app.getHttpServer())
    .post('/test-purchases')
    .set({ 'cf-connecting-ip': ip, ...headers });
const position = (id: string) =>
  request(app.getHttpServer()).get(`/test-purchases/${id}`);
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
  const { orderId, position } = response.body;
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

it('rejects a test-purchase body over 4 KB', async () => {
  const response = await buy()
    .set('content-type', 'application/json')
    .send(JSON.stringify({ rail: 'chain', note: 'x'.repeat(5000) }));
  expect(response.statusCode).toBe(413);
  expect(response.body).toEqual({ error: 'payload_too_large' });
  expect(await database.db.order.count()).toBe(0);
});

it('rejects a urlencoded body over 4 KB', async () => {
  const response = await buy()
    .set('content-type', 'application/x-www-form-urlencoded')
    .send(`rail=chain&note=${'x'.repeat(5000)}`);
  expect(response.statusCode).toBe(413);
  expect(response.body).toEqual({ error: 'payload_too_large' });
  expect(await database.db.order.count()).toBe(0);
});

it('admits back-to-back clicks from different visitors', async () => {
  const first = await buy('192.0.2.1');
  const second = await buy('192.0.2.2');
  expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
  expect(second.body.position).toBe(2);
});

it('limits one visitor to 10 a minute', async () => {
  for (let attempt = 0; attempt < 10; attempt++)
    expect((await buy()).statusCode).toBe(202);
  const denied = await buy();
  expect(denied.statusCode).toBe(429);
  expect(denied.body).toEqual({ error: 'rate_limited' });
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
  expect(denied.body).toEqual({ error: 'rate_limited' });
  expect(Number(denied.headers['retry-after'])).toBeGreaterThan(3600);
});

it('returns busy when 30 visitor purchases wait', async () => {
  await seedPending(30);
  const response = await buy();
  expect(response.statusCode).toBe(429);
  expect(response.body).toEqual({ error: 'busy' });
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
  expect(busy.every((response) => response.body.error === 'busy')).toBe(true);
  expect(accepted.map((response) => response.body.position)).toEqual(
    Array.from({ length: 30 }, (_, index) => index + 1),
  );
});

it('refuses past the visitor daily limit', async () => {
  limits.dailyLimit = 2;
  await buy('192.0.2.1');
  await buy('192.0.2.2');
  const response = await buy('192.0.2.3');
  expect(response.statusCode).toBe(409);
  expect(response.body).toEqual({ error: 'daily_limit' });
  expect(await database.db.order.count()).toBe(2);
});

it('pauses below the gas floor', async () => {
  gas = { native: limits.gasFloor - 1n, at: now.getTime() };
  const paused = await buy();
  expect(paused.statusCode).toBe(503);
  expect(paused.body).toEqual({ error: 'paused' });
  expect(await database.db.order.count()).toBe(0);
  gas = { native: limits.gasFloor, at: now.getTime() };
  expect((await buy()).statusCode).toBe(202);
});

it('admits when the gas reading is missing or stale', async () => {
  gas = null;
  expect((await buy('192.0.2.1')).statusCode).toBe(202);
  gas = { native: 0n, at: now.getTime() - 5 * 60 * 1000 - 1000 };
  expect((await buy('192.0.2.2')).statusCode).toBe(202);
});

it('reports queue position', async () => {
  const first = (await buy('192.0.2.1')).body;
  const second = (await buy('192.0.2.2')).body;
  expect((await position(first.orderId)).body).toEqual({
    position: 1,
    closed: false,
  });
  expect((await position(second.orderId)).body).toEqual({
    position: 2,
    closed: false,
  });
  await database.db.order.update({
    where: { id: second.orderId },
    data: { sendState: 'sent' },
  });
  for (const id of [second.orderId, randomUUID(), 'not-an-id']) {
    const response = await position(id);
    expect([response.statusCode, response.body]).toEqual([
      200,
      { position: 0, closed: false },
    ]);
  }
});

it('reports an order that closed without a payment being sent', async () => {
  const declined = (await buy('192.0.2.1')).body;
  const failed = (await buy('192.0.2.2')).body;
  const late = (await buy('192.0.2.3')).body;
  await database.db.order.update({
    where: { id: declined.orderId },
    data: { sendState: 'failed', status: 'expired' },
  });
  await database.db.order.update({
    where: { id: failed.orderId },
    data: { sendState: 'review', status: 'expired' },
  });
  await database.db.order.update({
    where: { id: late.orderId },
    data: { sendState: 'sent', status: 'expired' },
  });
  expect((await position(declined.orderId)).body).toEqual({
    position: 0,
    closed: true,
  });
  expect((await position(failed.orderId)).body).toEqual({
    position: 0,
    closed: true,
  });
  expect((await position(late.orderId)).body).toEqual({
    position: 0,
    closed: false,
  });
});

it('limits visitors by CF-Connecting-IP and ignores a forged X-Forwarded-For', async () => {
  limits.perMinute = 1;
  const first = await buy('198.51.100.1', { 'x-forwarded-for': '6.6.6.6' });
  const second = await buy('198.51.100.2', { 'x-forwarded-for': '6.6.6.6' });
  const forged = await buy('198.51.100.1', { 'x-forwarded-for': '7.7.7.7' });
  expect([first.statusCode, second.statusCode, forged.statusCode]).toEqual([
    202, 202, 429,
  ]);
});

it('ignores expired orders when checking the queue and counting position', async () => {
  await seedPending(30);
  await database.db.order.updateMany({
    where: { expectedAmount: { lte: 5n } },
    data: { status: 'expired' },
  });
  const response = await buy();
  expect(response.statusCode).toBe(202);
  expect(response.body.position).toBe(26);
});

it('admits from a fresh chain snapshot without an RPC call', async () => {
  const calls: string[] = [];
  await build((builder) => {
    builder.overrideProvider(ChainClient).useValue({
      getHead: async () => {
        calls.push('getHead');
        return { number: 1n, hash: '0x01' };
      },
      getBalances: async () => {
        calls.push('getBalances');
        return { native: limits.gasFloor - 1n, usdc: 0n };
      },
    });
  });
  await app.get(ChainSnapshotService).refresh();
  const before = calls.length;
  const response = await buy();
  expect(response.statusCode).toBe(503);
  expect(response.body).toEqual({ error: 'paused' });
  expect(calls).toHaveLength(before);
});

it('admits without waiting on a chain read that has not finished', async () => {
  await build((builder) => {
    builder.overrideProvider(ChainClient).useValue({
      getHead: () => new Promise<never>(() => {}),
      getBalances: () => new Promise<never>(() => {}),
    });
  });
  expect((await buy('192.0.2.1')).statusCode).toBe(202);
  expect((await buy('192.0.2.2')).statusCode).toBe(202);
});

it('ignores CF-Connecting-IP when no client header is configured', async () => {
  await build(undefined, '');
  limits.perMinute = 1;
  const first = await buy('198.51.100.1');
  const second = await buy('198.51.100.2');
  expect([first.statusCode, second.statusCode]).toEqual([202, 429]);
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
    positions.push((await position(row.id)).body.position);
  expect(positions).toEqual([1, 2, 3]);
  expect((await buy()).body.position).toBe(4);
});

it('answers with the item and price of the order it created', async () => {
  const response = await buy();
  const order = await database.db.order.findUniqueOrThrow({
    where: { id: response.body.orderId },
  });
  expect(response.body).toEqual({
    orderId: order.id,
    position: 1,
    item: order.item,
    price: order.price.toString(),
    expiresAt: order.expiresAt.toISOString(),
  });
});

it('keeps the item and price when sending could not be queued', async () => {
  jest
    .spyOn(app.get(OrderQueueService), 'queueSend')
    .mockRejectedValue(new Error('queue down'));
  const response = await buy();
  const order = await database.db.order.findFirstOrThrow();
  expect(response.statusCode).toBe(503);
  expect(response.body).toEqual({
    error: 'purchase_pending',
    orderId: order.id,
    item: order.item,
    price: order.price.toString(),
    expiresAt: order.expiresAt.toISOString(),
  });
});

const saveCard = () =>
  database.db.customer.create({
    data: {
      name: 'Demo customer',
      stripeCustomerId: 'cus_demo',
      stripePaymentMethodId: 'pm_demo',
      cardBrand: 'visa',
      cardLast4: '4242',
    },
  });
const buyBy = (rail: unknown, ip = '127.0.0.1') => buy(ip).send({ rail });

it('admits a card test purchase', async () => {
  const customer = await saveCard();
  const response = await buyBy('card');
  expect(response.statusCode).toBe(202);
  const order = await database.db.order.findUniqueOrThrow({
    where: { id: response.body.orderId },
  });
  expect(order).toMatchObject({
    rail: 'card',
    customerId: customer.id,
    expectedAmount: order.price,
  });
  expect((await queue.getJob(`visitor-${order.id}`))?.name).toBe(
    'visitor-purchase',
  );
});
it('answers card_unavailable without a saved card', async () => {
  const response = await buyBy('card');
  expect(response.statusCode).toBe(503);
  expect(response.body).toEqual({ error: 'card_unavailable' });
  expect(await database.db.order.count()).toBe(0);
});
it('admits a card purchase while chain purchases are paused', async () => {
  await saveCard();
  gas = { native: limits.gasFloor - 1n, at: now.getTime() };
  expect((await buyBy('card')).statusCode).toBe(202);
  expect((await buyBy('chain', '192.0.2.5')).statusCode).toBe(503);
});
it('defaults to the chain rail and accepts an explicit chain rail', async () => {
  await saveCard();
  const plain = await buy('192.0.2.1');
  const explicit = await buyBy('chain', '192.0.2.2');
  const rails = await database.db.order.findMany({
    where: { id: { in: [plain.body.orderId, explicit.body.orderId] } },
  });
  expect(rails.map((order) => order.rail)).toEqual(['chain', 'chain']);
});
it('rejects an unknown rail and unknown fields', async () => {
  expect((await buyBy('crypto')).statusCode).toBe(400);
  const extra = await buy().send({ rail: 'chain', amount: 1 });
  expect(extra.statusCode).toBe(400);
  expect(await database.db.order.count()).toBe(0);
});
it('counts card and chain purchases against one visitor limit', async () => {
  await saveCard();
  limits.dailyLimit = 2;
  expect((await buyBy('card', '192.0.2.1')).statusCode).toBe(202);
  expect((await buyBy('chain', '192.0.2.2')).statusCode).toBe(202);
  const denied = await buyBy('card', '192.0.2.3');
  expect([denied.statusCode, denied.body]).toEqual([
    409,
    { error: 'daily_limit' },
  ]);
});
it('publishes the waiting queue on the stream when it changes', async () => {
  const stream = await openEventStream(app);
  let body = '';
  stream.on('data', (chunk) => (body += String(chunk)));
  const queues = () =>
    [...body.matchAll(/event: queue\n(?:id: \d+\n)?data: (.*)\n/g)].map(
      ([, data]) => JSON.parse(data ?? '') as unknown,
    );
  const until = async (count: number) => {
    while (queues().length < count)
      await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const first = (await buy('192.0.2.1')).body.orderId as string;
  const second = (await buy('192.0.2.2')).body.orderId as string;
  await until(2);
  expect(queues().at(-1)).toEqual({ type: 'queue', waiting: [first, second] });
  const sent = await database.db.order.update({
    where: { id: first },
    data: { sendState: 'sent' },
  });
  await redis.publish(orderChannel, serializeOrder(sent));
  await until(3);
  expect(queues().at(-1)).toEqual({ type: 'queue', waiting: [second] });
  await redis.publish(orderChannel, serializeOrder(sent));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(queues()).toHaveLength(3);
  expect(body).not.toMatch(/"(item|price|expectedAmount)"/);
  stream.destroy();
});
