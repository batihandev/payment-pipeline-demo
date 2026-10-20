import type { Queue } from 'bullmq';
import type { PrismaClient } from '../../../libs/db/src';
import { Purchases } from './purchases';
export type BuyerJobData = { orderId?: string; day?: string };
export const retryOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
} as const;
export class BuyerJobs {
  constructor(
    private readonly db: PrismaClient,
    private readonly purchases: Purchases,
    private readonly queue: Queue<BuyerJobData>,
    private readonly rng = Math.random,
  ) {}
  async pace(now: Date) {
    const order = await this.purchases.pace(now);
    if (order)
      await this.queueSend(
        order.id,
        'schedule',
        Math.floor(this.rng() * 60000),
      );
    return order;
  }
  async queueSend(
    orderId: string,
    source: 'schedule' | 'visitor',
    delay = 0,
  ): Promise<void> {
    const visitor = source === 'visitor';
    await this.queue.add(
      visitor ? 'visitor-purchase' : 'send-order',
      { orderId },
      {
        ...retryOptions,
        jobId: `${visitor ? 'visitor' : 'send'}-${orderId}`,
        priority: visitor ? 1 : 10,
        delay: visitor ? 0 : delay,
      },
    );
  }
  async recoverPending(): Promise<void> {
    const orders = await this.db.order.findMany({
      where: {
        sendState: 'pending',
        OR: [{ status: 'open' }, { signedTransaction: { not: null } }],
      },
    });
    for (const order of orders) await this.queueSend(order.id, order.source);
  }
}
