import {
  Injectable,
  type MessageEvent,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { Observable, Subject, interval, map, merge, takeUntil } from 'rxjs';
import type { OrderEvent, QueueEvent } from '@app/core/api';
import { orderChannel } from '@app/events/order-events';
import { paymentChannel } from '@app/events/publish-payment';
import { subscribeEvents } from '@app/events/subscribe-events';
import { InjectRedis } from '@app/redis';
import type { ApiConfig } from '../common/api-config';
import { explorerUrl } from '../common/explorer-url';

/** Below the 100 s after which Cloudflare closes an idle connection. */
const KEEP_ALIVE_MS = 30_000;

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
    const explorer = this.config.get('BLOCK_EXPLORER_URL', { infer: true });
    this.unsubscribe = await subscribeEvents(this.redis, {
      [paymentChannel]: (body) => {
        this.changed.next();
        let payment: {
          donation: boolean;
          amount: string;
          transactionHash: string | null;
        };
        try {
          payment = JSON.parse(body) as typeof payment;
          if (payment.donation && BigInt(payment.amount) < donationMin) return;
        } catch {
          return;
        }
        // The list read's explorer link, which only the API can build.
        this.payments.next(
          JSON.stringify({
            ...payment,
            explorerUrl: explorerUrl(explorer, payment.transactionHash),
          }),
        );
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
   * Each published payment, with its explorer link, as an unnamed event; order changes and the waiting queue as named
   * `order` and `queue` events; and a `keep-alive` comment every 30 seconds.
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
      interval(KEEP_ALIVE_MS).pipe(
        map((): MessageEvent => ({ comment: 'keep-alive' })),
      ),
    ).pipe(takeUntil(this.closed));
  }
}
