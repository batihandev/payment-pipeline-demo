import type { OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../../../libs/db/src';
import { ViemChainClient } from '../../../libs/chain/src/viem-client';
import { serviceLimiter } from '../../../libs/chain/src/service-limiter';
import { registerReads, type ApiConfig } from './reads';
import { registerEvents } from './events';
import { registerNotices } from './notices';
import { recordGasPause, registerTestPurchases } from './test-purchases';
import { ChainSnapshot, buyerGas } from './chain-snapshot';
import {
  OrderQueueService,
  PurchasesService,
  purchaseOptions,
} from '../../../libs/orders/src';
import { QUEUES, type BuyerJobData } from '../../../libs/queues/src';
export class ApiRuntime implements OnModuleDestroy {
  readonly redis: Redis;
  readonly queues: Record<string, Queue>;
  constructor(
    readonly db: PrismaClient,
    readonly config: ApiConfig,
  ) {
    this.redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    this.redis.on('error', () => console.error('API Redis connection failed.'));
    this.queues = Object.fromEntries(
      Object.values(QUEUES).map((name) => {
        const queue = new Queue(name, {
          connection: { url: config.REDIS_URL },
        });
        queue.on('error', () => console.error('API queue connection failed.'));
        return [name, queue];
      }),
    );
  }
  async register(app: FastifyInstance): Promise<void> {
    const config = this.config;
    const chain = new ViemChainClient(
      {
        chainId: config.CHAIN_ID,
        rpcUrl: config.RPC_URL,
        usdcAddress: config.USDC_ADDRESS as `0x${string}`,
      },
      serviceLimiter(
        this.redis,
        'api',
        config.RPC_REQUESTS_PER_SECOND_API,
        config.RPC_COOLDOWN_MS,
      ),
    );
    await registerEvents(app, this.redis, config.DONATION_MIN);
    registerNotices(app, this.db, config.NOTICE_SECRET);
    const purchases = new PurchasesService(this.db, purchaseOptions(config));
    const queue = this.queues[QUEUES.buyer] as Queue<BuyerJobData>;
    const snapshot = new ChainSnapshot(
      chain,
      {
        buyer: config.BUYER_ADDRESS as `0x${string}`,
        shop: config.SHOP_ADDRESS as `0x${string}`,
      },
      { onRefresh: recordGasPause(this.redis, config.GAS_FLOOR) },
    );
    registerTestPurchases(
      app,
      this.redis,
      this.db,
      purchases,
      new OrderQueueService(this.db, queue),
      {
        latestBuyerGas: buyerGas(snapshot),
        limits: {
          perMinute: config.VISITOR_PER_MINUTE,
          perDay: config.VISITOR_PER_DAY,
          queueLimit: config.VISITOR_QUEUE_LIMIT,
          dailyLimit: config.VISITOR_DAILY_LIMIT,
          gasFloor: config.GAS_FLOOR,
        },
      },
    );
    registerReads(app, this.db, config, {
      snapshot,
      redis: this.redis,
      queues: this.queues,
    });
  }
  async onModuleDestroy(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
    await this.redis.quit();
  }
}
