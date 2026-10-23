import { randomUUID, createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Subscription } from 'rxjs';
import { PrismaService, type PaymentRail } from '../../../../libs/db/src';
import { errorFields } from '../../../../libs/logging/src';
import {
  OrderQueueService,
  PurchasesService,
} from '../../../../libs/orders/src';
import { orderClosed } from '../../../../libs/events/src/order-events';
import type {
  OrderPosition,
  PurchaseAccepted,
} from '../../../../libs/core/src/api';
import { utcDateKey } from '../../../../libs/core/src/time';
import { InjectRedis } from '../../../../libs/redis/src';
import { ApiError } from '../common/api-error';
import { InjectNow, type Now } from '../common/clock.module';
import { EventsService } from '../events/events.service';
import { CardRailService } from '../health/card-rail.service';
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

const logger = new Logger('TestPurchasesService');

@Injectable()
export class TestPurchasesService implements OnModuleInit, OnModuleDestroy {
  // Admissions run one at a time so the queue check and the new position stay exact.
  private turn: Promise<unknown> = Promise.resolve();
  private queueReading?: Promise<void>;
  private queueStale = false;
  private subscription?: Subscription;

  constructor(
    private readonly db: PrismaService,
    @InjectRedis() private readonly redis: Redis,
    private readonly purchases: PurchasesService,
    private readonly orderQueue: OrderQueueService,
    private readonly cardRail: CardRailService,
    private readonly snapshot: ChainSnapshotService,
    @Inject(VISITOR_LIMITS) private readonly limits: VisitorLimits,
    @Inject(VISITOR_PREFIX) private readonly prefix: string,
    @InjectNow() private readonly now: Now,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.events.orderChanged.subscribe(
      () => void this.refreshQueue(),
    );
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /**
   * Reads the waiting visitor orders and sends them to the streams. A change that arrives during
   * a read starts one more read after it, so the last snapshot sent is never older than a change.
   */
  private refreshQueue(): Promise<void> {
    this.queueStale = true;
    this.queueReading ??= (async () => {
      while (this.queueStale) {
        this.queueStale = false;
        try {
          const orders = await this.db.order.findMany({
            where: waiting,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: this.limits.queueLimit,
            select: { id: true },
          });
          this.events.publishQueue(orders.map(({ id }) => id));
        } catch (error) {
          logger.error('Could not read the visitor queue.', errorFields(error));
        }
      }
      this.queueReading = undefined;
    })();
    return this.queueReading;
  }

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

  buy(address: string, rail: PaymentRail): Promise<PurchaseAccepted> {
    return this.exclusive(async () => {
      const now = this.now();
      let created: Omit<PurchaseAccepted, 'position'> | undefined;
      try {
        if (rail === 'card') {
          if (!(await this.cardRail.available()))
            throw new ApiError(503, 'card_unavailable');
        } else if (await this.paused(now)) throw new ApiError(503, 'paused');
        if (
          (await this.db.order.count({ where: waiting })) >=
          this.limits.queueLimit
        )
          throw new ApiError(429, 'busy', {}, { 'Retry-After': '2' });
        await this.admitVisitor(address, now);
        const order = await this.purchases.visitor(
          randomUUID(),
          rail,
          now,
          this.limits.dailyLimit,
        );
        if (!order) throw new ApiError(409, 'daily_limit');
        created = {
          orderId: order.id,
          item: order.item,
          price: order.price.toString(),
          expiresAt: order.expiresAt.toISOString(),
        };
        await this.orderQueue.queueSend(order.id, 'visitor');
        void this.refreshQueue();
        return { ...created, position: await this.position(order) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw created
          ? new ApiError(503, 'purchase_pending', created)
          : new ApiError(503, 'purchases_unavailable');
      }
    });
  }

  /** The queue position of a waiting order, and whether it closed without a payment being sent. */
  async positionOf(id: string): Promise<OrderPosition> {
    const unknown = { position: 0, closed: false };
    if (!uuid.test(id)) return unknown;
    const order = await this.db.order.findUnique({ where: { id } });
    if (!order) return unknown;
    const isWaiting =
      order.source === waiting.source &&
      order.sendState === waiting.sendState &&
      order.status === waiting.status;
    return {
      position: isWaiting ? await this.position(order) : 0,
      closed: orderClosed(order),
    };
  }
}
