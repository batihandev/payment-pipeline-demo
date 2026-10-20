import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, UnrecoverableError, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { z } from 'zod';
import { RpcLimiter } from '../../../libs/chain/src/rpc-limiter';
import { ViemChainClient } from '../../../libs/chain/src/viem-client';
import { RpcError } from '../../../libs/chain/src/rpc-error';
import type { buyerSchema } from '../../../libs/config/src';
import type { PrismaClient } from '../../../libs/db/src';
import { Purchases } from './purchases';
import { BuyerJobs, retryOptions, type BuyerJobData } from './jobs';
import { RedisLock } from './redis-lock';
import { OrderSender } from './send-order';
import { NightlySweep } from './sweep';
import { expireOrders } from './expiry';

export type BuyerConfig = z.output<typeof buyerSchema>;
export class BuyerRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queue: Queue<BuyerJobData>;
  private readonly worker: Worker<BuyerJobData>;
  private readonly purchases: Purchases;
  private readonly jobs: BuyerJobs;
  private readonly sender: OrderSender;
  private readonly sweep: NightlySweep;
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
    const limiter = new RpcLimiter(
      config.RPC_REQUESTS_PER_SECOND,
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
    this.purchases = new Purchases(db, {
      cap: { count: config.DAILY_COUNT_CAP, amount: config.DAILY_AMOUNT_CAP },
      seed: String(config.CHAIN_ID),
      ttlMinutes: config.ORDER_TTL_MINUTES,
      quietStart: config.QUIET_START_HOUR_UTC,
      quietEnd: config.QUIET_END_HOUR_UTC,
    });
    const connection = { url: config.REDIS_URL };
    this.queue = new Queue<BuyerJobData>('buyer', { connection });
    this.queue.on('error', () =>
      console.error('Buyer queue connection failed.'),
    );
    this.jobs = new BuyerJobs(db, this.purchases, this.queue);
    this.sender = new OrderSender(db, chain, chain, new RedisLock(this.redis), {
      buyer,
      shop,
      chainId: config.CHAIN_ID,
    });
    this.sweep = new NightlySweep(db, chain, this.sender, shop);
    this.worker = new Worker<BuyerJobData>(
      'buyer',
      (job) => this.process(job),
      { connection, concurrency: 1, autorun: false },
    );
    this.worker.on('error', () =>
      console.error('Buyer worker connection failed.'),
    );
  }
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'buyer-minute',
      { pattern: '* * * * *', tz: 'UTC' },
      {
        name: 'pace-minute',
        data: {},
        opts: {
          ...retryOptions,
          priority: 5,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    );
    await this.queue.upsertJobScheduler(
      'buyer-expiry',
      { pattern: '* * * * *', tz: 'UTC' },
      {
        name: 'expire-orders',
        data: {},
        opts: {
          ...retryOptions,
          priority: 5,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    );
    await this.queue.upsertJobScheduler(
      'buyer-sweep',
      { pattern: '0 3 * * *', tz: 'UTC' },
      {
        name: 'nightly-sweep',
        data: {},
        opts: {
          ...retryOptions,
          priority: 10,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    );
    await this.jobs.recoverPending();
    void this.worker.run().catch(() => console.error('Buyer worker stopped.'));
  }
  private async process(job: Job<BuyerJobData>): Promise<void> {
    const now = new Date();
    const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      switch (job.name) {
        case 'pace-minute':
          await this.jobs.recoverPending();
          await this.jobs.pace(now);
          return;
        case 'expire-orders':
          await expireOrders(this.db, now);
          return;
        case 'nightly-sweep':
          await this.sweep.run(
            new Date(job.opts.prevMillis ?? job.timestamp),
            exhausted,
          );
          return;
        case 'visitor-purchase': {
          if (!job.data.orderId)
            throw new UnrecoverableError('Missing purchase order id');
          const order = await this.purchases.visitor(job.data.orderId, now);
          if (!order) return;
          await this.sender.sendForOrder(order.id, exhausted);
          return;
        }
        case 'send-order':
          if (!job.data.orderId)
            throw new UnrecoverableError('Missing purchase order id');
          await this.sender.sendForOrder(job.data.orderId, exhausted);
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
  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.redis.quit();
  }
}
