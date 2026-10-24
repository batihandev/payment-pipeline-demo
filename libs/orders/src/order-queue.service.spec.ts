import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { testDatabase } from '@testing/db/database';
import { testRedisUrl } from '@testing/config/redis';
import type { BuyerJobData } from '@app/queues';
import { OrderQueueService } from './order-queue.service';
import { CustomersService } from './customers.service';
import { PurchasesService } from './purchases.service';

let database: Awaited<ReturnType<typeof testDatabase>>;
let queue: Queue<BuyerJobData>;
let purchases: PurchasesService;
let orderQueue: OrderQueueService;
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
  orderQueue = new OrderQueueService(database.db, queue);
});
afterEach(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
});
it('runs a visitor purchase ahead of queued scheduled sends without pacing or a second reservation', async () => {
  const order = await purchases.visitor(randomUUID(), 'chain', now);
  if (!order) throw new Error('Expected order');
  await orderQueue.queueSend(order.id, 'schedule');
  await orderQueue.queueSend(order.id, 'visitor');
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
            ? await purchases.visitor(job.data.orderId, 'chain', now)
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
      worker.once('completed', () => {
        resolve();
      });
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
  const row = await purchases.visitor(randomUUID(), 'chain', now);
  await orderQueue.recoverPending();
  expect((await queue.getJob(`visitor-${row?.id}`))?.data.orderId).toBe(
    row?.id,
  );
  expect(await database.db.order.count()).toBe(1);
});
