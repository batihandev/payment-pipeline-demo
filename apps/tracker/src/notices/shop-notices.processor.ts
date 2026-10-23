import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../../libs/queues/src';
import { NoticeSenderService } from './notice-sender.service';

@Processor(QUEUES.shopNotices, { concurrency: 1, autorun: false })
export class ShopNoticesProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  constructor(private readonly sender: NoticeSenderService) {
    super();
  }

  onApplicationBootstrap(): void {
    void this.worker
      .run()
      .catch(() => console.error('Shop notice worker stopped.'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent('error')
  onError(): void {
    console.error('Shop notice worker connection failed.');
  }

  async process(job: Job<{ paymentId: string }>): Promise<void> {
    await this.sender.send(
      job.data.paymentId,
      job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    );
  }
}
