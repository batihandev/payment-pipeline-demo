import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import { OrdersModule } from '../../../../libs/orders/src/orders.module';
import { QUEUES } from '../../../../libs/queues/src';
import { createTestApp } from '../../testing/app';
import { HealthModule } from './health.module';
import { HEALTH_QUEUES } from './health.service';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp({ queuePrefix: 'queue-errors-test' });
});
afterAll(async () => {
  await app.close();
});

it.each([
  [
    'health',
    HealthModule,
    Object.values(QUEUES).filter((name) => name !== QUEUES.buyer),
  ],
  ['orders', OrdersModule, [QUEUES.buyer]],
] as const)(
  'logs only the fixed line for a %s queue connection failure',
  (_name, module, names) => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const name of names) {
        const queue = app
          .select(module)
          .get<Queue>(getQueueToken(name), { strict: false });
        queue.emit('error', new Error('refused'));
      }
      expect(log).toHaveBeenCalledTimes(names.length);
      for (const call of log.mock.calls)
        expect(call).toEqual(['API queue connection failed.']);
    } finally {
      log.mockRestore();
    }
  },
);

it('reads health from the buyer queue that orders owns, logging one line per failure', () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const owned = app
      .select(OrdersModule)
      .get<Queue>(getQueueToken(QUEUES.buyer));
    const read = app
      .get<Queue[]>(HEALTH_QUEUES, { strict: false })
      .find((queue) => queue.name === QUEUES.buyer);
    expect(read).toBe(owned);
    owned.emit('error', new Error('refused'));
    expect(log.mock.calls).toEqual([['API queue connection failed.']]);
  } finally {
    log.mockRestore();
  }
});
