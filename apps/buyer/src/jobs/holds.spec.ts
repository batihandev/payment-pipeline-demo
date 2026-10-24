import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { testDatabase } from '@testing/db/database';
import { CustomersService, PurchasesService } from '@app/orders';
import type { BuyerJobData } from '@app/queues';
import { ExpiryService } from '../expiry/expiry.service';
import { holdWhenFull, holdWhenShort } from './holds';
import { OrderSenderService } from '../sending/order-sender.service';
import { testRedisUrl } from '@testing/config/redis';
import { fakeConfig } from '@testing/config/config';
import type { BuyerConfig } from '../buyer-config';

let database: Awaited<ReturnType<typeof testDatabase>>;
let queue: Queue<BuyerJobData>;
let purchases: PurchasesService;
const now = new Date('2026-10-20T12:00:00Z');
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.db.order.deleteMany();
  await database.db.dailyBudget.deleteMany();
  queue = new Queue(`buyer-test-${randomUUID()}`, {
    connection: { url: testRedisUrl() },
  });
  purchases = new PurchasesService(
    database.db,
    {
      cap: { count: 20, amount: 100000000n },
      seed: 'test',
      ttlMinutes: 30,
      quietStart: 0,
      quietEnd: 7,
      cardRail: true,
    },
    () => 0,
    new CustomersService(database.db),
  );
});
afterEach(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
});
it('delays a send while 10 are in flight without using an attempt', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const row = await database.db.order.create({
      data: {
        item: 'Duck',
        price: 99n,
        expectedAmount: 100n,
        source: 'schedule',
        sendState: 'sent',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 1800000),
        payments: {
          create: {
            provider: 'chain',
            externalKey: `sent:${randomUUID()}`,
            amount: 100n,
            stage: 'sent',
          },
        },
      },
    });
    ids.push(row.id);
  }
  const sender = new OrderSenderService(
    database.db,
    {} as never,
    {} as never,
    {} as never,
    `0x${'11'.repeat(20)}`,
    `0x${'22'.repeat(20)}`,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 1 }),
  );
  await queue.add('send-order', { orderId: ids[0] }, { attempts: 1 });
  let sent = false;
  let delays = 0;
  const worker = new Worker(
    queue.name,
    async (job: Job<BuyerJobData>, token?: string) => {
      try {
        await holdWhenFull(job, token, sender, 10);
      } catch (error) {
        delays += 1;
        throw error;
      }
      sent = true;
    },
    { connection: { url: testRedisUrl() }, autorun: false },
  );
  try {
    const done = new Promise<void>((resolve, reject) => {
      worker.once('completed', () => {
        resolve();
      });
      worker.once('error', reject);
    });
    const running = worker.run();
    while (delays === 0) await new Promise((r) => setTimeout(r, 50));
    expect(sent).toBe(false);
    expect((await queue.getJobs(['delayed']))[0]?.attemptsMade).toBe(0);
    await database.db.payment.updateMany({
      where: { orderId: ids[1] },
      data: { stage: 'received' },
    });
    await done;
    await worker.close();
    await running;
    expect(sent).toBe(true);
    expect((await queue.getJobs(['completed']))[0]?.attemptsMade).toBe(1);
  } finally {
    await worker.close();
  }
});

it('delays a short send without using an attempt', async () => {
  const row = await purchases.visitor(randomUUID(), 'chain', now);
  if (!row) throw new Error('Expected order');
  await queue.add('send-order', { orderId: row.id }, { attempts: 1 });
  const covers = jest.fn(() => Promise.resolve(false));
  let delays = 0;
  let sent = false;
  const worker = new Worker(
    queue.name,
    async (job: Job<BuyerJobData>, token?: string) => {
      try {
        await holdWhenShort(job, token, { covers }, row.id);
      } catch (error) {
        delays += 1;
        throw error;
      }
      sent = true;
    },
    { connection: { url: testRedisUrl() }, autorun: false },
  );
  try {
    const running = worker.run();
    const deadline = Date.now() + 5000;
    while (delays === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    await worker.close();
    await running;
    expect(delays).toBe(1);
    expect(sent).toBe(false);
    expect(covers).toHaveBeenCalledWith(row.id);
    const [held] = await queue.getJobs(['delayed']);
    expect(held?.attemptsMade).toBe(0);
  } finally {
    await worker.close();
  }
});

it('runs the refill while visitor sends are held', async () => {
  const upkeep = new Queue<BuyerJobData>(`buyer-upkeep-test-${randomUUID()}`, {
    connection: { url: testRedisUrl() },
  });
  const connection = { url: testRedisUrl() };
  let holds = 0;
  const visitors = new Worker(
    queue.name,
    async (job: Job<BuyerJobData>, token?: string) => {
      try {
        await holdWhenShort(
          job,
          token,
          { covers: () => Promise.resolve(false) },
          'x',
        );
      } catch (error) {
        holds += 1;
        throw error;
      }
    },
    { connection, concurrency: 1, autorun: false },
  );
  const done = { refilled: false };
  const refills = new Worker(
    upkeep.name,
    () => {
      done.refilled = true;
      return Promise.resolve();
    },
    { connection, concurrency: 1, autorun: false },
  );
  try {
    await queue.add('visitor-purchase', { orderId: 'x' }, { priority: 1 });
    const runningVisitors = visitors.run();
    const deadline = Date.now() + 5000;
    while (holds === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    await upkeep.add('refill-check', {}, { priority: 3 });
    const runningRefills = refills.run();
    while (!done.refilled && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    await Promise.all([visitors.close(), refills.close()]);
    await Promise.all([runningVisitors, runningRefills]);
    expect(holds).toBeGreaterThan(0);
    expect(done.refilled).toBe(true);
    expect(await queue.getJobCounts('completed')).toEqual({ completed: 0 });
  } finally {
    await Promise.all([visitors.close(), refills.close()]);
    await upkeep.obliterate({ force: true });
    await upkeep.close();
  }
});

it('expires orders on the upkeep queue while visitor sends are held', async () => {
  const upkeep = new Queue<BuyerJobData>(`buyer-upkeep-test-${randomUUID()}`, {
    connection: { url: testRedisUrl() },
  });
  const connection = { url: testRedisUrl() };
  const stale = await database.db.order.create({
    data: {
      item: 'Duck',
      price: 99n,
      expectedAmount: 100n,
      source: 'schedule',
      createdAt: new Date(now.getTime() - 3600000),
      expiresAt: new Date(now.getTime() - 1800000),
    },
  });
  let holds = 0;
  const visitors = new Worker(
    queue.name,
    async (job: Job<BuyerJobData>, token?: string) => {
      try {
        await holdWhenShort(
          job,
          token,
          { covers: () => Promise.resolve(false) },
          'x',
        );
      } catch (error) {
        holds += 1;
        throw error;
      }
    },
    { connection, concurrency: 1, autorun: false },
  );
  const done = { expired: false };
  const expiry = new Worker(
    upkeep.name,
    async () => {
      await new ExpiryService(database.db).expireOrders(now);
      done.expired = true;
    },
    { connection, concurrency: 1, autorun: false },
  );
  try {
    await queue.add('visitor-purchase', { orderId: 'x' }, { priority: 1 });
    const runningVisitors = visitors.run();
    const deadline = Date.now() + 5000;
    while (holds === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    await upkeep.add('expire-orders', {}, { priority: 5 });
    const runningExpiry = expiry.run();
    while (!done.expired && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    await Promise.all([visitors.close(), expiry.close()]);
    await Promise.all([runningVisitors, runningExpiry]);
    expect(holds).toBeGreaterThan(0);
    expect(done.expired).toBe(true);
    expect(
      (await database.db.order.findUniqueOrThrow({ where: { id: stale.id } }))
        .status,
    ).toBe('expired');
  } finally {
    await Promise.all([visitors.close(), expiry.close()]);
    await upkeep.obliterate({ force: true });
    await upkeep.close();
  }
});
