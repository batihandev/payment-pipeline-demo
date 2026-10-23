import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { testDatabase } from '../../../../libs/db/testing/database';
import {
  OrderQueueService,
  CustomersService,
  PurchasesService,
} from '../../../../libs/orders/src';
import type { BuyerJobData } from '../../../../libs/queues/src';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import { PaceService } from './pace.service';

let database: Awaited<ReturnType<typeof testDatabase>>;
let queue: Queue<BuyerJobData>;
let jobs: PaceService;
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
  jobs = new PaceService(
    new PurchasesService(
      database.db,
      {
        cap: { count: 20, amount: 100000000n },
        seed: 'test',
        ttlMinutes: 30,
        quietStart: 0,
        quietEnd: 7,
      },
      () => 0,
      new CustomersService(database.db),
    ),
    new OrderQueueService(database.db, queue),
    () => 0.25,
  );
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
it('keeps a scheduled send inside the current minute when the pacing job starts late', async () => {
  const row = await jobs.pace(new Date('2026-10-20T12:00:50Z'));
  expect((await queue.getJob(`send-${row?.id}`))?.delay).toBe(2500);
});
