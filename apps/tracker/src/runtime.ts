import { Redis } from 'ioredis';
import { PaymentDelivery } from './delivery';
import { NoticeSender } from './notices';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { Queue, Worker, UnrecoverableError } from 'bullmq';
import type { z } from 'zod';
import { serviceLimiter } from '../../../libs/chain/src/service-limiter';
import { ViemChainClient } from '../../../libs/chain/src/viem-client';
import type { Address } from '../../../libs/chain/src/chain-client';
import type { trackerSchema } from '../../../libs/config/src';
import type { PrismaClient } from '../../../libs/db/src';
import { Scanner } from './scanner';
import { PaymentProgress } from './progress';
import { GapRecovery } from './gaps';
import { TrackerPoller } from './polling';
export type TrackerConfig = z.output<typeof trackerSchema>;
export class TrackerRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly redis: Redis;
  private readonly noticeQueue: Queue<{ paymentId: string }>;
  private readonly noticeWorker: Worker<{ paymentId: string }>;
  private readonly poller: TrackerPoller;
  private readonly stopped = new AbortController();
  private loop: Promise<void> | undefined;
  constructor(
    private readonly db: PrismaClient,
    private readonly config: TrackerConfig,
  ) {
    this.redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    this.redis.on('error', () =>
      console.error('Tracker Redis connection failed.'),
    );
    const chain = new ViemChainClient(
      {
        chainId: config.CHAIN_ID,
        rpcUrl: config.RPC_URL,
        usdcAddress: config.USDC_ADDRESS as Address,
        shopAddress: config.SHOP_ADDRESS as Address,
      },
      serviceLimiter(
        this.redis,
        'tracker',
        config.RPC_REQUESTS_PER_SECOND_TRACKER,
        config.RPC_COOLDOWN_MS,
      ),
    );
    const scanner = new Scanner(db, chain, {
      startBlock: config.START_BLOCK,
      chainId: config.CHAIN_ID,
      shop: config.SHOP_ADDRESS,
      maxRange: config.MAX_RANGE,
      minRange: config.MIN_RANGE,
      rescanBlocks: config.RESCAN_BLOCKS,
      rpcAttempts: config.RPC_MAX_ATTEMPTS,
      gapAttempts: config.GAP_MAX_ATTEMPTS,
      confirmations: config.CONFIRMATIONS,
    });
    this.poller = new TrackerPoller(
      db,
      scanner,
      new PaymentProgress(db, scanner),
      { active: config.ACTIVE_POLL_MS, idle: config.IDLE_POLL_MS },
    );
    const gaps = new GapRecovery(db, scanner);
    const connection = { url: config.REDIS_URL };
    this.queue = new Queue('tracker', { connection });

    this.noticeQueue = new Queue('shop-notices', { connection });
    this.noticeQueue.on('error', () =>
      console.error('Shop notice queue connection failed.'),
    );
    const sender = new NoticeSender(db, {
      url: config.SHOP_NOTICE_URL,
      secret: config.NOTICE_SECRET,
    });
    this.noticeWorker = new Worker<{ paymentId: string }>(
      'shop-notices',
      (job) =>
        sender.send(
          job.data.paymentId,
          job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
        ),
      { connection, concurrency: 1, autorun: false },
    );
    this.noticeWorker.on('error', () =>
      console.error('Shop notice worker connection failed.'),
    );
    const delivery = new PaymentDelivery(db, this.redis, this.noticeQueue);
    this.worker = new Worker(
      'tracker',
      async (job) => {
        if (job.name === 'deliver-payments') {
          await delivery.flush();
          return;
        }
        if (job.name !== 'retry-gap')
          throw new UnrecoverableError('Unknown tracker job');
        await gaps.retryOnce();
      },
      { connection, concurrency: 1, autorun: false },
    );
    this.queue.on('error', () =>
      console.error('Tracker queue connection failed.'),
    );
    this.worker.on('error', () =>
      console.error('Tracker worker connection failed.'),
    );
  }
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'tracker-gaps',
      { every: 10000 },
      {
        name: 'retry-gap',
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 100 },
      },
    );
    void this.worker
      .run()
      .catch(() => console.error('Tracker worker stopped.'));
    await this.queue.upsertJobScheduler(
      'tracker-delivery',
      { every: 2000 },
      {
        name: 'deliver-payments',
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 100 },
      },
    );
    void this.noticeWorker
      .run()
      .catch(() => console.error('Shop notice worker stopped.'));
    this.loop = this.poll();
  }
  private async poll(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      let delay = this.config.ACTIVE_POLL_MS;
      try {
        delay = await this.poller.pass();
      } catch {
        try {
          await this.db.incident.create({
            data: {
              kind: 'tracker_pass_failed',
              whatHappened: 'The tracker pass could not finish.',
              howHandled:
                'Retained database state and scheduled the next poll.',
            },
          });
        } catch {
          console.error('Tracker database connection failed.');
        }
      }
      try {
        await setTimeout(delay, undefined, { signal: this.stopped.signal });
      } catch {
        break;
      }
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped.abort();
    await this.loop;
    await this.worker.close();
    await this.queue.close();
    await this.noticeWorker.close();
    await this.noticeQueue.close();
    await this.redis.quit();
  }
}
