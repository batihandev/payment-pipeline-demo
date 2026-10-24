import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { PrismaService } from '@app/db';
import { cooldownKey } from '@app/chain/service-limiter';
import type { HealthRecord } from '@app/core/api';
import { VISITOR_PAUSED_SINCE } from '@app/core/redis-keys';
import { InjectRedis } from '@app/redis';
import { ApiError } from '../common/api-error';
import type { ApiConfig } from '../common/api-config';
import { CardRailService } from './card-rail.service';
import {
  ChainSnapshotService,
  type Balance,
  type ChainErrorCategory,
} from './chain-snapshot.service';

export const HEALTH_QUEUES = Symbol('HEALTH_QUEUES');

@Injectable()
export class HealthService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<ApiConfig, true>,
    @InjectRedis() private readonly redis: Redis,
    @Inject(HEALTH_QUEUES) private readonly queues: Queue[],
    private readonly snapshot: ChainSnapshotService,
    private readonly cardRail: CardRailService,
  ) {}

  private async readMonitoring() {
    const [unsettled, unnotified, scheduled] = await Promise.all([
      this.db.$queryRaw<
        { at: Date | null }[]
      >`SELECT MIN(COALESCE(p.processing_at, p.sent_at, p.received_at)) AS at FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.send_state <> 'failed' AND p.stage IN ('sent', 'received', 'confirming', 'processing')`,
      this.db.payment.aggregate({
        where: { stage: 'settled', donation: false },
        _min: { settledAt: true },
      }),
      this.db.order.findFirst({
        where: { source: 'schedule' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    return {
      oldestUnsettledAt: unsettled[0]?.at ?? null,
      oldestUnnotifiedAt: unnotified._min.settledAt,
      lastScheduledPurchaseAt: scheduled?.createdAt ?? null,
    };
  }

  private readRedis() {
    return Promise.all([
      Promise.all(
        this.queues.map(async (queue) => {
          const counts = await queue.getJobCounts(
            'waiting',
            'prioritized',
            'active',
            'delayed',
          );
          return [
            queue.name,
            Object.values(counts).reduce((sum, n) => sum + n, 0),
          ] as const;
        }),
      ),
      Promise.all(
        ['buyer', 'tracker', 'api', 'stripe'].map(
          async (name) =>
            [
              name,
              Math.max(0, await this.redis.pttl(cooldownKey(name))),
            ] as const,
        ),
      ),
      this.redis.get(VISITOR_PAUSED_SINCE),
    ]);
  }

  // Only a database failure fails /health. Redis parts are null while Redis is down, and chain
  // parts come from the shared snapshot, so a slow or failing RPC provider never delays it.
  async read(): Promise<HealthRecord> {
    const get = <K extends keyof ApiConfig>(key: K): ApiConfig[K] =>
      this.config.get(key, { infer: true });
    const [database, live] = await Promise.allSettled([
      Promise.all([
        this.db.cursor.findUnique({
          where: {
            name: `chain-${get('CHAIN_ID')}-${get('SHOP_ADDRESS').toLowerCase()}`,
          },
        }),
        this.db.scanGap.count({ where: { resolvedAt: null } }),
        this.readMonitoring(),
        this.cardRail.available(),
      ]),
      this.readRedis(),
    ]);
    if (database.status === 'rejected')
      throw new ApiError(503, 'Live health state is unavailable');
    const [cursor, openGaps, monitoring, cardAvailable] = database.value;
    const [depths, cooldowns, pausedSince] =
      live.status === 'fulfilled' ? live.value : [null, null, null];
    const { reading, error } = this.snapshot.current();
    const chain = error ? null : reading;
    const chainError: ChainErrorCategory | null =
      error ?? (reading ? null : 'not_loaded');
    const balances = (balance: Balance) => ({
      ...balance,
      lowNative: balance.native < get('LOW_NATIVE_BALANCE'),
      lowUsdc: balance.usdc < get('LOW_USDC_BALANCE'),
    });
    return {
      confirmations: get('CONFIRMATIONS'),
      head: chain?.head ?? null,
      cursor: cursor?.blockNumber ?? null,
      lag:
        chain && cursor
          ? chain.head > cursor.blockNumber
            ? chain.head - cursor.blockNumber
            : 0n
          : null,
      openGaps,
      queueDepth: depths && Object.fromEntries(depths),
      cooldowns: cooldowns && Object.fromEntries(cooldowns),
      balances: chain
        ? {
            buyer: balances(chain.balances.buyer),
            shop: balances(chain.balances.shop),
          }
        : null,
      chainError,
      cardAvailable,
      redisError: live.status === 'rejected' ? 'unavailable' : null,
      monitoring: {
        ...monitoring,
        cursorAdvancedAt: cursor?.advancedAt ?? null,
        visitorPausedSince: pausedSince
          ? new Date(Number(pausedSince)).toISOString()
          : null,
      },
    };
  }
}
