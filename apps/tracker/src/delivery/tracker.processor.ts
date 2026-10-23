import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { JOBS, QUEUES } from '../../../../libs/queues/src';
import { GapRecoveryService } from '../gaps/gap-recovery.service';
import { DeliveryService } from './delivery.service';

@Processor(QUEUES.tracker, { concurrency: 1, autorun: false })
export class TrackerProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  constructor(
    private readonly delivery: DeliveryService,
    private readonly gaps: GapRecoveryService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    void this.worker
      .run()
      .catch(() => console.error('Tracker worker stopped.'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent('error')
  onError(): void {
    console.error('Tracker worker connection failed.');
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
