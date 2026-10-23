import {
  Injectable,
  type MessageEvent,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { Observable, Subject, interval, map, merge, takeUntil } from 'rxjs';
import {
  orderChannel,
  type OrderEvent,
  type QueueEvent,
} from '../../../../libs/events/src/order-events';
import { paymentChannel } from '../../../../libs/events/src/publish-payment';
import { subscribeEvents } from '../../../../libs/events/src/subscribe-events';
import { InjectRedis } from '../../../../libs/redis/src';
import type { ApiConfig } from '../common/api-config';

const HEARTBEAT_MS = 15000;

function readOrder(body: string): OrderEvent | null {
  try {
    const { id, closed } = JSON.parse(body) as Partial<OrderEvent>;
    return typeof id === 'string' && typeof closed === 'boolean'
      ? { type: 'order', id, closed }
      : null;
  } catch {
    return null;
  }
}

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly payments = new Subject<string>();
  private readonly orders = new Subject<string>();
  private readonly queues = new Subject<string>();
  private lastQueue?: string;
  private readonly closed = new Subject<void>();
  private readonly changed = new Subject<void>();
  private readonly orderChange = new Subject<void>();
  /** Emits for every received payment event, before the event reaches any stream. */
  readonly paymentChanged: Observable<void> = this.changed.asObservable();
  /** Emits for every received order event, after the event reaches the streams. */
  readonly orderChanged: Observable<void> = this.orderChange.asObservable();
  private unsubscribe?: () => Promise<void>;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    const donationMin = this.config.get('DONATION_MIN', { infer: true });
    this.unsubscribe = await subscribeEvents(this.redis, {
      [paymentChannel]: (body) => {
        this.changed.next();
        try {
          const payment = JSON.parse(body) as {
            donation: boolean;
            amount: string;
          };
          if (payment.donation && BigInt(payment.amount) < donationMin) return;
        } catch {
          return;
        }
        this.payments.next(body);
      },
      [orderChannel]: (body) => {
        const order = readOrder(body);
        if (order) this.orders.next(JSON.stringify(order));
        this.orderChange.next();
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.closed.next();
    await this.unsubscribe?.();
  }

  /** Sends the waiting visitor orders to every stream, unless they are the ones sent last. */
  publishQueue(waiting: string[]): void {
    const event: QueueEvent = { type: 'queue', waiting };
    const body = JSON.stringify(event);
    if (body === this.lastQueue) return;
    this.lastQueue = body;
    this.queues.next(body);
  }

  /**
   * Each published payment as an unnamed event; order changes and the waiting queue as named
   * `order` and `queue` events; and a named heartbeat.
   */
  stream(): Observable<MessageEvent> {
    return merge(
      this.payments.pipe(map((body): MessageEvent => ({ data: body }))),
      this.orders.pipe(
        map((body): MessageEvent => ({ type: 'order', data: body })),
      ),
      this.queues.pipe(
        map((body): MessageEvent => ({ type: 'queue', data: body })),
      ),
      interval(HEARTBEAT_MS).pipe(
        map((): MessageEvent => ({ type: 'heartbeat', data: '' })),
      ),
    ).pipe(takeUntil(this.closed));
  }
}
