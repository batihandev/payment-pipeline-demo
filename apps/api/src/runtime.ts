import type { OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../../../libs/db/src';
import { ViemChainClient } from '../../../libs/chain/src/viem-client';
import { serviceLimiter } from '../../../libs/chain/src/service-limiter';
import { registerReads, type ApiConfig } from './reads';
import { registerEvents } from './events';
import { registerTestPurchases } from './test-purchases';
import { Purchases, purchaseOptions } from '../../buyer/src/purchases';
import { BuyerJobs, type BuyerJobData } from '../../buyer/src/jobs';
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
      ['buyer', 'tracker', 'shop-notices'].map((name) => {
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
        config.RPC_REQUESTS_PER_SECOND,
        config.RPC_COOLDOWN_MS,
      ),
    );
    await registerEvents(app, this.redis);
    const purchases = new Purchases(this.db, purchaseOptions(config));
    const queue = this.queues.buyer as Queue<BuyerJobData>;
    registerTestPurchases(
      app,
      this.redis,
      purchases,
      new BuyerJobs(this.db, purchases, queue),
    );
    registerReads(app, this.db, config, {
      chain,
      redis: this.redis,
      queues: this.queues,
    });
  }
  async onModuleDestroy(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
    await this.redis.quit();
  }
}
