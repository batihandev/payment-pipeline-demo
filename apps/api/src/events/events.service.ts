import {
  Injectable,
  type MessageEvent,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { Observable, Subject, interval, map, merge, takeUntil } from 'rxjs';
import { subscribePayments } from '../../../../libs/events/src/subscribe-payments';
import { InjectRedis } from '../../../../libs/redis/src';
import type { ApiConfig } from '../common/api-config';

const HEARTBEAT_MS = 15000;

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly payments = new Subject<string>();
  private readonly closed = new Subject<void>();
  private unsubscribe?: () => Promise<void>;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    const donationMin = this.config.get('DONATION_MIN', { infer: true });
    this.unsubscribe = await subscribePayments(this.redis, (body) => {
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
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.closed.next();
    await this.unsubscribe?.();
  }

  /** Each published payment as an unnamed event, and a named heartbeat while idle. */
  stream(): Observable<MessageEvent> {
    return merge(
      this.payments.pipe(map((body): MessageEvent => ({ data: body }))),
      interval(HEARTBEAT_MS).pipe(
        map((): MessageEvent => ({ type: 'heartbeat', data: '' })),
      ),
    ).pipe(takeUntil(this.closed));
  }
}
