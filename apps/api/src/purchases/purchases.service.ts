import { randomUUID, createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../../../libs/db/src';
import {
  OrderQueueService,
  PurchasesService,
} from '../../../../libs/orders/src';
import { utcDateKey } from '../../../../libs/core/src/time';
import { InjectRedis } from '../../../../libs/redis/src';
import { ApiError } from '../common/api-error';
import { InjectNow, type Now } from '../common/clock.module';
import { ChainSnapshotService } from '../health/chain-snapshot.service';
import {
  VISITOR_LIMITS,
  VISITOR_PREFIX,
  admit,
  type VisitorLimits,
} from './visitor-limits';

const staleReadingMs = 5 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const waiting = {
  source: 'visitor',
  sendState: 'pending',
  status: 'open',
} as const;

@Injectable()
export class TestPurchasesService {
  // Admissions run one at a time so the queue check and the new position stay exact.
  private turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly purchases: PurchasesService,
    private readonly orderQueue: OrderQueueService,
    private readonly snapshot: ChainSnapshotService,
    @Inject(VISITOR_LIMITS) private readonly limits: VisitorLimits,
    @Inject(VISITOR_PREFIX) private readonly prefix: string,
    @InjectNow() private readonly now: Now,
  ) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.turn.then(task);
    this.turn = result.catch(() => undefined);
    return result;
  }

  // Waiting orders are ordered by (createdAt, id), so two created in the same millisecond
  // still get distinct positions.
  private async position(order: { id: string; createdAt: Date }) {
    return (
      1 +
      (await this.db.order.count({
        where: {
          ...waiting,
          OR: [
            { createdAt: { lt: order.createdAt } },
            { createdAt: order.createdAt, id: { lt: order.id } },
          ],
        },
      }))
    );
  }

  private async paused(now: Date): Promise<boolean> {
    const reading = await this.snapshot.buyerGas();
    return (
      reading !== null &&
      now.getTime() - reading.at <= staleReadingMs &&
      reading.native < this.limits.gasFloor
    );
  }

  private async admitVisitor(address: string, now: Date): Promise<void> {
    const ip = createHash('sha256').update(address).digest('hex');
    const day = utcDateKey(now);
    const [verdict, wait] = (await this.redis.eval(
      admit,
      2,
      `${this.prefix}:min:${ip}`,
      `${this.prefix}:day:${ip}:${day}`,
      this.limits.perMinute,
      this.limits.perDay,
    )) as [number, number];
    if (verdict === 0) return;
    const midnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const seconds =
      verdict === 1
        ? Math.ceil(wait / 1000)
        : Math.ceil((midnight - now.getTime()) / 1000);
    throw new ApiError(
      429,
      'rate_limited',
      {},
      { 'Retry-After': String(Math.max(1, seconds)) },
    );
  }

  buy(address: string): Promise<{ orderId: string; position: number }> {
    return this.exclusive(async () => {
      const now = this.now();
      let orderId: string | undefined;
      try {
        if (await this.paused(now)) throw new ApiError(503, 'paused');
        if (
          (await this.db.order.count({ where: waiting })) >=
          this.limits.queueLimit
        )
          throw new ApiError(429, 'busy', {}, { 'Retry-After': '2' });
        await this.admitVisitor(address, now);
        const order = await this.purchases.visitor(
          randomUUID(),
          now,
          this.limits.dailyLimit,
        );
        if (!order) throw new ApiError(409, 'daily_limit');
        orderId = order.id;
        await this.orderQueue.queueSend(order.id, 'visitor');
        return { orderId: order.id, position: await this.position(order) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw orderId
          ? new ApiError(503, 'purchase_pending', { orderId })
          : new ApiError(503, 'purchases_unavailable');
      }
    });
  }

  async positionOf(id: string): Promise<{ position: number }> {
    if (!uuid.test(id)) return { position: 0 };
    const order = await this.db.order.findFirst({ where: { id, ...waiting } });
    return { position: order ? await this.position(order) : 0 };
  }
}
