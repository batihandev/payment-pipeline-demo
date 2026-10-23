import {
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { JOBS, QUEUES, type BuyerJobData } from '../../../../libs/queues/src';
import { ExpiryService } from '../expiry/expiry.service';
import { RefillService } from '../refill/refill.service';
import { OrderSenderService } from '../sending/order-sender.service';
import { SweepService } from '../sweep/sweep.service';
import { mapJobError } from './job-errors';

@Processor(QUEUES.buyerUpkeep, { concurrency: 1, autorun: false })
export class UpkeepProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  constructor(
    private readonly expiry: ExpiryService,
    private readonly sweep: SweepService,
    private readonly sender: OrderSenderService,
    private readonly refill: RefillService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    void this.worker
      .run()
      .catch(() => console.error('Buyer upkeep worker stopped.'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent('error')
  onError(): void {
    console.error('Buyer upkeep worker connection failed.');
  }

  async process(job: Job<BuyerJobData>): Promise<void> {
    const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      switch (job.name) {
        case JOBS.buyerUpkeep.expireOrders:
          await this.expiry.expireOrders(new Date());
          return;
        case JOBS.buyerUpkeep.nightlySweep:
          await this.sweep.run(
            new Date(job.opts.prevMillis ?? job.timestamp),
            exhausted,
          );
          return;
        case JOBS.buyerUpkeep.checkUnseen:
          await this.sender.checkUnseen(new Date());
          return;
        case JOBS.buyerUpkeep.refillCheck:
          await this.refill.run(exhausted);
          return;
        default:
          throw new UnrecoverableError('Unknown buyer job');
      }
    } catch (error) {
      mapJobError(error);
    }
  }
}
