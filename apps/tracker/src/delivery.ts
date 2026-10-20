import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import type { PrismaClient } from '../../../libs/db/src';
import { paymentChannel } from '../../../libs/events/src/publish-payment';
export const noticeRetryOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
} as const;
export class PaymentDelivery {
  constructor(
    readonly db: PrismaClient,
    readonly redis: Pick<Redis, 'publish'>,
    readonly queue: Queue<{ paymentId: string }>,
    readonly now = () => new Date(),
  ) {}
  async flush(): Promise<void> {
    const events = await this.db.paymentEvent.findMany({
      where: { publishedAt: null },
      orderBy: { id: 'asc' },
      take: 100,
    });
    for (const event of events) {
      try {
        await this.redis.publish(paymentChannel, event.body);
      } catch {
        await this.db.incident.create({
          data: {
            kind: 'event_failed',
            paymentId: event.paymentId,
            whatHappened: 'Payment event publication failed.',
            howHandled:
              'Retained the persisted event for the next delivery pass.',
          },
        });
        throw new Error('Payment event publication failed');
      }
      await this.db.paymentEvent.update({
        where: { id: event.id },
        data: { publishedAt: this.now() },
      });
    }
    const notices = await this.db.notice.findMany({
      where: {
        deliveredAt: null,
        attempts: { lt: noticeRetryOptions.attempts },
      },
      take: 100,
      orderBy: { paymentId: 'asc' },
    });
    for (const notice of notices)
      await this.queue.add(
        'shop-notice',
        { paymentId: notice.paymentId },
        {
          ...noticeRetryOptions,
          attempts: noticeRetryOptions.attempts - notice.attempts,
          jobId: `notice-${notice.paymentId}`,
        },
      );
  }
}
