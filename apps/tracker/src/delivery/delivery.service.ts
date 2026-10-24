import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { PrismaService, recordIncident } from '@app/db';
import { JOBS, QUEUES } from '@app/queues';
import { InjectRedis } from '@app/redis';
import { noticeRetryOptions } from '../notices/notice-retry';
import { orderChannel, serializeOrder } from '@app/events/order-events';
import { paymentChannel } from '@app/events/publish-payment';
@Injectable()
export class DeliveryService {
  constructor(
    private readonly db: PrismaService,
    @InjectRedis() private readonly redis: Pick<Redis, 'publish'>,
    @InjectQueue(QUEUES.shopNotices)
    private readonly queue: Queue<{ paymentId: string }>,
    @Optional() private readonly now = () => new Date(),
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
        await recordIncident(this.db, {
          kind: 'event_failed',
          paymentId: event.paymentId,
          whatHappened: 'Payment event publication failed.',
          howHandled:
            'Retained the persisted event for the next delivery pass.',
        });
        throw new Error('Payment event publication failed');
      }
      await this.db.paymentEvent.update({
        where: { id: event.id },
        data: { publishedAt: this.now() },
      });
    }
    await this.flushOrders();
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
        JOBS.shopNotices.shopNotice,
        { paymentId: notice.paymentId },
        {
          ...noticeRetryOptions,
          attempts: noticeRetryOptions.attempts - notice.attempts,
          jobId: `notice-${notice.paymentId}`,
        },
      );
  }

  /** Publishes each changed order's current state once, however many changes it had. */
  private async flushOrders(): Promise<void> {
    const events = await this.db.orderEvent.findMany({
      where: { publishedAt: null },
      orderBy: { id: 'asc' },
      take: 100,
      include: {
        order: { select: { id: true, status: true, sendState: true } },
      },
    });
    const orders = new Map(events.map((event) => [event.orderId, event.order]));
    for (const order of orders.values()) {
      try {
        await this.redis.publish(orderChannel, serializeOrder(order));
      } catch {
        await recordIncident(this.db, {
          kind: 'event_failed',
          whatHappened: 'Order event publication failed.',
          howHandled:
            'Retained the persisted event for the next delivery pass.',
        });
        throw new Error('Order event publication failed');
      }
      await this.db.orderEvent.updateMany({
        where: {
          orderId: order.id,
          id: { lte: events.at(-1)?.id },
          publishedAt: null,
        },
        data: { publishedAt: this.now() },
      });
    }
  }
}
