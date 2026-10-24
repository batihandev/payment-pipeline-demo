import {
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { JOBS, QUEUES, type BuyerJobData } from '@app/queues';
import { CardReconcilerService } from '../cards/card-reconciler.service';
import { ExpiryService } from '../expiry/expiry.service';
import { RefillService } from '../refill/refill.service';
import { OrderSenderService } from '../sending/order-sender.service';
import { SweepService } from '../sweep/sweep.service';
import { mapJobError } from './job-errors';
import { errorFields } from '@app/logging';

@Processor(QUEUES.buyerUpkeep, { concurrency: 1, autorun: false })
export class UpkeepProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(UpkeepProcessor.name);

  constructor(
    private readonly expiry: ExpiryService,
    private readonly sweep: SweepService,
    private readonly sender: OrderSenderService,
    private readonly refill: RefillService,
    private readonly cards: CardReconcilerService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    void this.worker.run().catch((error: unknown) => {
      this.logger.error('Buyer upkeep worker stopped.', errorFields(error));
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      'Buyer upkeep worker connection failed.',
      errorFields(error),
    );
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
        case JOBS.buyerUpkeep.reconcileCards:
          await this.cards.run(new Date());
          return;
        default:
          throw new UnrecoverableError('Unknown buyer job');
      }
    } catch (error) {
      mapJobError(error);
    }
  }
}
