import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { testDatabase } from '../../../libs/db/testing/database';
import { Purchases } from './purchases';
import {
  BuyerJobs,
  holdWhenFull,
  holdWhenShort,
  type BuyerJobData,
} from './jobs';
import { OrderSender } from './send-order';
import { testRedisUrl } from '../../../libs/config/testing/redis';

let database: Awaited<ReturnType<typeof testDatabase>>;
let queue: Queue<BuyerJobData>;
let purchases: Purchases;
let jobs: BuyerJobs;
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
  purchases = new Purchases(
    database.db,
    {
      cap: { count: 20, amount: 100000000n },
      seed: 'test',
      ttlMinutes: 30,
      quietStart: 0,
      quietEnd: 7,
    },
    () => 0,
  );
  jobs = new BuyerJobs(database.db, purchases, queue, () => 0.25);
});
afterEach(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
});
it('queues a paced order for a random point inside its minute', async () => {
  const order = await jobs.pace(now);
  expect(order).not.toBeNull();
  const queued = await queue.getJob(`send-${order?.id}`);
  expect(queued?.delay).toBe(15000);
  expect(queued?.data.orderId).toBe(order?.id);
  expect(queued?.opts.backoff).toEqual({
    type: 'exponential',
    delay: 1000,
    jitter: 0.5,
  });
});
it('runs a visitor purchase ahead of queued scheduled sends without pacing or a second reservation', async () => {
  const order = await purchases.visitor(randomUUID(), now);
  if (!order) throw new Error('Expected order');
  await jobs.queueSend(order.id, 'schedule');
  await jobs.queueSend(order.id, 'visitor');
  const visitor = await queue.getJob(`visitor-${order.id}`);
  expect(visitor?.name).toBe('visitor-purchase');
  expect(visitor?.priority).toBe(1);
  expect(visitor?.delay).toBe(0);
  const completed: string[] = [];
  const worker = new Worker(
    queue.name,
    async (job: Job<BuyerJobData>) => {
      if (job.data.orderId) {
        const row =
          job.name === 'visitor-purchase'
            ? await purchases.visitor(job.data.orderId, now)
            : await database.db.order.findUnique({
                where: { id: job.data.orderId },
              });
        if (row) completed.push(job.name);
      }
    },
    { connection: { url: testRedisUrl() }, autorun: false },
  );
  try {
    const first = new Promise<void>((resolve, reject) => {
      worker.once('completed', () => resolve());
      worker.once('error', reject);
    });
    const running = worker.run();
    await first;
    await worker.close();
    await running;
    expect(completed[0]).toBe('visitor-purchase');
    expect(
      (await queue.getJob(`visitor-${order.id}`))?.finishedOn,
    ).toBeDefined();
    expect(
      await database.db.dailyBudget.findUniqueOrThrow({
        where: { day: new Date('2026-10-20') },
      }),
    ).toMatchObject({ reservedCount: 0 });
  } finally {
    await worker.close();
  }
});
it('recovers an order whose process stopped after reservation and before enqueueing', async () => {
  const row = await purchases.visitor(randomUUID(), now);
  await jobs.recoverPending();
  expect((await queue.getJob(`visitor-${row?.id}`))?.data.orderId).toBe(
    row?.id,
  );
  expect(await database.db.order.count()).toBe(1);
});

it('keeps a scheduled send inside the current minute when the pacing job starts late', async () => {
  const row = await jobs.pace(new Date('2026-10-20T12:00:50Z'));
  expect((await queue.getJob(`send-${row?.id}`))?.delay).toBe(2500);
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
  const sender = new OrderSender(
    database.db,
    {} as never,
    {} as never,
    {} as never,
    { buyer: `0x${'11'.repeat(20)}`, shop: `0x${'22'.repeat(20)}`, chainId: 1 },
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
      worker.once('completed', () => resolve());
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
  const row = await purchases.visitor(randomUUID(), now);
  if (!row) throw new Error('Expected order');
  await queue.add('send-order', { orderId: row.id }, { attempts: 1 });
  const covers = jest.fn(async () => false);
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
        await holdWhenShort(job, token, { covers: async () => false }, 'x');
      } catch (error) {
        holds += 1;
        throw error;
      }
    },
    { connection, concurrency: 1, autorun: false },
  );
  let refilled = false;
  const refills = new Worker(
    upkeep.name,
    async () => {
      refilled = true;
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
    while (!refilled && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    await Promise.all([visitors.close(), refills.close()]);
    await Promise.all([runningVisitors, runningRefills]);
    expect(holds).toBeGreaterThan(0);
    expect(refilled).toBe(true);
    expect(await queue.getJobCounts('completed')).toEqual({ completed: 0 });
  } finally {
    await Promise.all([visitors.close(), refills.close()]);
    await upkeep.obliterate({ force: true });
    await upkeep.close();
  }
});
