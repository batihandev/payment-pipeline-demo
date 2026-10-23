import {
  Inject,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { DAY_MS } from '../../../../libs/core/src/time';
import {
  PrismaService,
  type PaymentRail,
  recordIncident,
} from '../../../../libs/db/src';
import { publishPayment } from '../../../../libs/events/src/publish-payment';
import {
  OrderQueueService,
  PurchasesService,
} from '../../../../libs/orders/src';
import { JOBS, QUEUES, type BuyerJobData } from '../../../../libs/queues/src';
import { REDIS } from '../../../../libs/redis/src';
import type { BuyerConfig } from '../buyer-config';
import { CardSenderService } from '../cards/card-sender.service';
import { RetentionService } from '../retention/retention.service';
import { FundsService } from '../sending/funds.service';
import { OrderSenderService } from '../sending/order-sender.service';
import { holdWhenFull, holdWhenShort } from './holds';
import { mapJobError } from './job-errors';
import { PaceService } from './pace.service';
import { errorFields } from '../../../../libs/logging/src';

@Processor(QUEUES.buyer, { concurrency: 1, autorun: false })
export class BuyerProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BuyerProcessor.name);

  private readonly maxInFlight: number;
  private readonly retentionMs: number;

  constructor(
    private readonly db: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly purchases: PurchasesService,
    private readonly orderQueue: OrderQueueService,
    private readonly pacing: PaceService,
    private readonly sender: OrderSenderService,
    private readonly cards: CardSenderService,
    private readonly funds: FundsService,
    private readonly retention: RetentionService,
    config: ConfigService<BuyerConfig, true>,
  ) {
    super();
    this.maxInFlight = config.get('MAX_IN_FLIGHT', { infer: true });
    this.retentionMs = config.get('RETENTION_DAYS', { infer: true }) * DAY_MS;
  }

  onApplicationBootstrap(): void {
    void this.worker.run().catch((error: unknown) => {
      this.logger.error('Buyer worker stopped.', errorFields(error));
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error('Buyer worker connection failed.', errorFields(error));
  }

  async process(job: Job<BuyerJobData>, token?: string): Promise<void> {
    const sends =
      job.name === JOBS.buyer.sendOrder ||
      job.name === JOBS.buyer.visitorPurchase;
    // A visitor purchase whose order the API has not written yet is a chain purchase.
    const rail: PaymentRail =
      sends && job.data.orderId
        ? ((
            await this.db.order.findUnique({
              where: { id: job.data.orderId },
              select: { rail: true },
            })
          )?.rail ?? 'chain')
        : 'chain';
    if (sends && rail !== 'card') {
      await holdWhenFull(job, token, this.sender, this.maxInFlight);
      if (job.data.orderId)
        await holdWhenShort(job, token, this.funds, job.data.orderId);
    }
    const now = new Date();
    const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      switch (job.name) {
        case JOBS.buyer.paceMinute:
          await this.orderQueue.recoverPending();
          await this.pacing.pace(now);
          return;
        case JOBS.buyer.retention: {
          const counts = await this.retention.pruneOlderThan(
            new Date(now.getTime() - this.retentionMs),
          );
          this.logger.log('Retention removed old rows.', counts);
          return;
        }
        case JOBS.buyer.visitorPurchase: {
          if (!job.data.orderId)
            throw new UnrecoverableError('Missing purchase order id');
          const order = await this.purchases.visitor(
            job.data.orderId,
            rail,
            now,
          );
          if (!order) return;
          await this.sendPurchase(order.id, order.rail, exhausted);
          return;
        }
        case JOBS.buyer.sendOrder:
          if (!job.data.orderId)
            throw new UnrecoverableError('Missing purchase order id');
          await this.sendPurchase(job.data.orderId, rail, exhausted);
          return;
        default:
          throw new UnrecoverableError('Unknown buyer job');
      }
    } catch (error) {
      mapJobError(error);
    }
  }

  private async sendPurchase(
    orderId: string,
    rail: PaymentRail,
    exhausted: boolean,
  ): Promise<void> {
    if (rail === 'card') await this.cards.charge(orderId, exhausted);
    else await this.sender.sendForOrder(orderId, exhausted);
    const payment = await this.db.payment.findFirst({ where: { orderId } });
    if (!payment) return;
    try {
      await publishPayment(this.redis, payment);
    } catch {
      await recordIncident(this.db, {
        kind: 'event_failed',
        paymentId: payment.id,
        whatHappened: 'Could not publish the saved payment event.',
        howHandled: exhausted
          ? 'Publication retries exhausted; the saved payment is available for clients to refetch.'
          : 'Payment remains saved; retry publication with the purchase job.',
      });
      throw new RpcError('transient');
    }
  }
}
