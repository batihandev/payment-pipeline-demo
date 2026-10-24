import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '@app/db';
import { JOBS, QUEUES, retryOptions, type BuyerJobData } from '@app/queues';

@Injectable()
export class OrderQueueService {
  constructor(
    private readonly db: PrismaService,
    @InjectQueue(QUEUES.buyer) private readonly queue: Queue<BuyerJobData>,
  ) {}

  async queueSend(
    orderId: string,
    source: 'schedule' | 'visitor',
    delay = 0,
  ): Promise<void> {
    const visitor = source === 'visitor';
    await this.queue.add(
      visitor ? JOBS.buyer.visitorPurchase : JOBS.buyer.sendOrder,
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
