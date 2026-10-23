import { publishPayment } from '../../../libs/events/src/publish-payment';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, UnrecoverableError, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { z } from 'zod';
import { serviceLimiter } from '../../../libs/chain/src/service-limiter';
import { ViemChainClient } from '../../../libs/chain/src/viem-client';
import { RpcError } from '../../../libs/chain/src/rpc-error';
import type { buyerSchema } from '../../../libs/config/src';
import type { PrismaClient } from '../../../libs/db/src';
import {
  OrderQueueService,
  PurchasesService,
  purchaseOptions,
} from '../../../libs/orders/src';
import {
  JOBS,
  QUEUES,
  schedulerJobOptions,
  type BuyerJobData,
} from '../../../libs/queues/src';
import { DAY_MS } from '../../../libs/core/src/time';
import { BuyerJobs, holdWhenFull, holdWhenShort } from './jobs';
import { RedisLock } from './redis-lock';
import { OrderSender } from './send-order';
import { NightlySweep } from './sweep';
import { Refill } from './refill';
import { BuyerFunds } from './funds';
import { expireOrders } from './expiry';
import { pruneOlderThan } from './retention';

export type BuyerConfig = z.output<typeof buyerSchema>;
export class BuyerRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queue: Queue<BuyerJobData>;
  private readonly worker: Worker<BuyerJobData>;
  private readonly upkeepQueue: Queue<BuyerJobData>;
  private readonly upkeepWorker: Worker<BuyerJobData>;
  private readonly funds: BuyerFunds;
  private readonly purchases: PurchasesService;
  private readonly orderQueue: OrderQueueService;
  private readonly jobs: BuyerJobs;
  private readonly sender: OrderSender;
  private readonly sweep: NightlySweep;
  private readonly refill: Refill;
  private readonly refillEveryMs: number;
  private readonly maxInFlight: number;
  private readonly retentionMs: number;
  constructor(
    private readonly db: PrismaClient,
    config: BuyerConfig,
  ) {
    this.redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    this.redis.on('error', () =>
      console.error('Buyer Redis connection failed.'),
    );
    const buyerKey = config.BUYER_PRIVATE_KEY as Hex;
    const shopKey = config.SHOP_PRIVATE_KEY as Hex;
    const buyer = privateKeyToAccount(buyerKey).address;
    const shop = privateKeyToAccount(shopKey).address;
    const limiter = serviceLimiter(
      this.redis,
      'buyer',
      config.RPC_REQUESTS_PER_SECOND_BUYER,
      config.RPC_COOLDOWN_MS,
    );
    const chain = new ViemChainClient(
      {
        chainId: config.CHAIN_ID,
        rpcUrl: config.RPC_URL,
        usdcAddress: config.USDC_ADDRESS as Hex,
        shopAddress: shop,
        keys: [buyerKey, shopKey],
      },
      limiter,
    );
    this.maxInFlight = config.MAX_IN_FLIGHT;
    this.retentionMs = config.RETENTION_DAYS * DAY_MS;
    this.purchases = new PurchasesService(db, purchaseOptions(config));
    const connection = { url: config.REDIS_URL };
    this.queue = new Queue<BuyerJobData>(QUEUES.buyer, { connection });
    this.queue.on('error', () =>
      console.error('Buyer queue connection failed.'),
    );
    this.upkeepQueue = new Queue<BuyerJobData>(QUEUES.buyerUpkeep, {
      connection,
    });
    this.upkeepQueue.on('error', () =>
      console.error('Buyer upkeep queue connection failed.'),
    );
    this.orderQueue = new OrderQueueService(db, this.queue);
    this.jobs = new BuyerJobs(this.purchases, this.orderQueue);
    this.sender = new OrderSender(db, chain, chain, new RedisLock(this.redis), {
      buyer,
      shop,
      chainId: config.CHAIN_ID,
    });
    this.funds = new BuyerFunds(db, chain, buyer);
    this.sweep = new NightlySweep(db, chain, this.sender, shop);
    this.refillEveryMs = config.REFILL_COOLDOWN_SECONDS * 1000;
    this.refill = new Refill(db, chain, this.sender, buyer, shop, {
      below: config.REFILL_BELOW,
      cooldownMs: this.refillEveryMs,
    });
    this.worker = new Worker<BuyerJobData>(
      QUEUES.buyer,
      (job, token) => this.process(job, token),
      { connection, concurrency: 1, autorun: false },
    );
    this.worker.on('error', () =>
      console.error('Buyer worker connection failed.'),
    );
    this.upkeepWorker = new Worker<BuyerJobData>(
      QUEUES.buyerUpkeep,
      (job) => this.processUpkeep(job),
      { connection, concurrency: 1, autorun: false },
    );
    this.upkeepWorker.on('error', () =>
      console.error('Buyer upkeep worker connection failed.'),
    );
  }
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'buyer-minute',
      { pattern: '* * * * *', tz: 'UTC' },
      {
        name: JOBS.buyer.paceMinute,
        data: {},
        opts: schedulerJobOptions(5),
      },
    );
    await this.queue.upsertJobScheduler(
      'buyer-retention',
      { pattern: '30 3 * * *', tz: 'UTC' },
      {
        name: JOBS.buyer.retention,
        data: {},
        opts: schedulerJobOptions(10),
      },
    );
    await this.queue.removeJobScheduler('buyer-refill');
    await this.queue.removeJobScheduler('buyer-unseen');
    await this.queue.removeJobScheduler('buyer-expiry');
    await this.queue.removeJobScheduler('buyer-sweep');
    await this.upkeepQueue.upsertJobScheduler(
      'buyer-refill',
      { every: this.refillEveryMs },
      {
        name: JOBS.buyerUpkeep.refillCheck,
        data: {},
        opts: schedulerJobOptions(3),
      },
    );
    await this.upkeepQueue.upsertJobScheduler(
      'buyer-unseen',
      { every: 60_000 },
      {
        name: JOBS.buyerUpkeep.checkUnseen,
        data: {},
        opts: schedulerJobOptions(4),
      },
    );
    await this.upkeepQueue.upsertJobScheduler(
      'buyer-expiry',
      { pattern: '* * * * *', tz: 'UTC' },
      {
        name: JOBS.buyerUpkeep.expireOrders,
        data: {},
        opts: schedulerJobOptions(5),
      },
    );
    await this.upkeepQueue.upsertJobScheduler(
      'buyer-sweep',
      { pattern: '0 3 * * *', tz: 'UTC' },
      {
        name: JOBS.buyerUpkeep.nightlySweep,
        data: {},
        opts: schedulerJobOptions(10),
      },
    );
    await this.orderQueue.recoverPending();
    void this.worker.run().catch(() => console.error('Buyer worker stopped.'));
    void this.upkeepWorker
      .run()
      .catch(() => console.error('Buyer upkeep worker stopped.'));
  }
  private async process(job: Job<BuyerJobData>, token?: string): Promise<void> {
    if (
      job.name === JOBS.buyer.sendOrder ||
      job.name === JOBS.buyer.visitorPurchase
    ) {
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
          await this.jobs.pace(now);
          return;
        case JOBS.buyer.retention: {
          const counts = await pruneOlderThan(
            this.db,
            new Date(now.getTime() - this.retentionMs),
          );
          console.log(`Retention removed ${JSON.stringify(counts)}`);
          return;
        }
        case JOBS.buyer.visitorPurchase: {
          if (!job.data.orderId)
            throw new UnrecoverableError('Missing purchase order id');
          const order = await this.purchases.visitor(job.data.orderId, now);
          if (!order) return;
          await this.sendPurchase(order.id, exhausted);
          return;
        }
        case JOBS.buyer.sendOrder:
          if (!job.data.orderId)
            throw new UnrecoverableError('Missing purchase order id');
          await this.sendPurchase(job.data.orderId, exhausted);
          return;
        default:
          throw new UnrecoverableError('Unknown buyer job');
      }
    } catch (error) {
      if (error instanceof RpcError && error.kind === 'permanent')
        throw new UnrecoverableError(error.message);
      if (error instanceof UnrecoverableError) throw error;
      throw new RpcError('transient');
    }
  }
  private async processUpkeep(job: Job<BuyerJobData>): Promise<void> {
    const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      switch (job.name) {
        case JOBS.buyerUpkeep.expireOrders:
          await expireOrders(this.db, new Date());
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
      if (error instanceof RpcError && error.kind === 'permanent')
        throw new UnrecoverableError(error.message);
      if (error instanceof UnrecoverableError) throw error;
      throw new RpcError('transient');
    }
  }
  private async sendPurchase(
    orderId: string,
    exhausted: boolean,
  ): Promise<void> {
    await this.sender.sendForOrder(orderId, exhausted);
    const payment = await this.db.payment.findFirst({ where: { orderId } });
    if (!payment) return;
    try {
      await publishPayment(this.redis, payment);
    } catch {
      await this.db.incident.create({
        data: {
          kind: 'event_failed',
          paymentId: payment.id,
          whatHappened: 'Could not publish the saved payment event.',
          howHandled: exhausted
            ? 'Publication retries exhausted; the saved payment is available for clients to refetch.'
            : 'Payment remains saved; retry publication with the purchase job.',
        },
      });
      throw new RpcError('transient');
    }
  }
  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.upkeepWorker.close();
    await this.queue.close();
    await this.upkeepQueue.close();
    await this.redis.quit();
  }
}
