import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { testDatabase } from '../../../libs/db/src/test-database';
import { Purchases } from './purchases';
import { BuyerJobs, type BuyerJobData } from './jobs';

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
    connection: { host: '127.0.0.1', port: 56379 },
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
    { connection: { host: '127.0.0.1', port: 56379 }, autorun: false },
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
    ).toMatchObject({ reservedCount: 1 });
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
