import {
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { JOBS, QUEUES } from '../../../../libs/queues/src';
import { GapRecoveryService } from '../gaps/gap-recovery.service';
import { DeliveryService } from './delivery.service';
import { errorFields } from '../../../../libs/logging/src';

@Processor(QUEUES.tracker, { concurrency: 1, autorun: false })
export class TrackerProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TrackerProcessor.name);

  constructor(
    private readonly delivery: DeliveryService,
    private readonly gaps: GapRecoveryService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    void this.worker.run().catch((error: unknown) => {
      this.logger.error('Tracker worker stopped.', errorFields(error));
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error('Tracker worker connection failed.', errorFields(error));
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case JOBS.tracker.deliverPayments:
        await this.delivery.flush();
        return;
      case JOBS.tracker.retryGap:
        await this.gaps.retryOnce();
        return;
      default:
        throw new UnrecoverableError('Unknown tracker job');
    }
  }
}
