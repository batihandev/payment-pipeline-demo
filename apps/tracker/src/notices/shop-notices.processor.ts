import {
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../../libs/queues/src';
import { NoticeSenderService } from './notice-sender.service';
import { errorFields } from '../../../../libs/logging/src';

@Processor(QUEUES.shopNotices, { concurrency: 1, autorun: false })
export class ShopNoticesProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShopNoticesProcessor.name);

  constructor(private readonly sender: NoticeSenderService) {
    super();
  }

  onApplicationBootstrap(): void {
    void this.worker.run().catch((error: unknown) => {
      this.logger.error('Shop notice worker stopped.', errorFields(error));
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      'Shop notice worker connection failed.',
      errorFields(error),
    );
  }

  async process(job: Job<{ paymentId: string }>): Promise<void> {
    await this.sender.send(
      job.data.paymentId,
      job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    );
  }
}
