import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Subscription } from 'rxjs';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../../../../libs/db/src';
import { publicPayment } from '../../../../libs/events/src/public-payment';
import { receiptNoteKinds } from '../../../../libs/core/src/receipt-notes';
import type { ApiConfig } from '../common/api-config';
import { InjectNow, type Now } from '../common/clock.module';
import { ttlCache } from '../common/ttl-cache';

const CACHE_MS = 5000;

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly cached = new Map<number, () => Promise<unknown>>();
  private subscription?: Subscription;

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<ApiConfig, true>,
    @InjectNow() private readonly now: Now,
    private readonly events: EventsService,
  ) {}

  /** A page refetches after each live event, so a cached list must never predate one. */
  onModuleInit(): void {
    this.subscription = this.events.paymentChanged.subscribe(() =>
      this.cached.clear(),
    );
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /** At most 100 distinct limits pass validation, so the cache stays small. */
  list(limit: number): Promise<unknown> {
    let read = this.cached.get(limit);
    if (!read) {
      read = ttlCache(
        CACHE_MS,
        () => this.query(limit),
        () => this.now().getTime(),
      );
      this.cached.set(limit, read);
    }
    return read();
  }

  private async query(limit: number): Promise<unknown> {
    const donationMin = this.config.get('DONATION_MIN', { infer: true });
    const explorer = this.config.get('BLOCK_EXPLORER_URL', { infer: true });
    const ids = await this.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM payments WHERE NOT (donation AND amount < ${donationMin}) ORDER BY COALESCE(sent_at, received_at) DESC NULLS LAST, id DESC LIMIT ${limit}`;
    const rows = await this.db.payment.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      include: {
        incidents: {
          where: { kind: { in: [...receiptNoteKinds] } },
          select: { kind: true },
          distinct: ['kind'],
        },
        order: {
          select: {
            id: true,
            item: true,
            price: true,
            expectedAmount: true,
            status: true,
            source: true,
            createdAt: true,
            expiresAt: true,
          },
        },
      },
    });
    return rows
      .sort(
        (a, b) =>
          ids.findIndex((row) => row.id === a.id) -
          ids.findIndex((row) => row.id === b.id),
      )
      .map(({ incidents, ...row }) => ({
        ...publicPayment(row),
        noteKinds: incidents.map((incident) => incident.kind),
        order: row.order,
        explorerUrl: row.transactionHash
          ? `${explorer.replace(/\/$/, '')}/tx/${row.transactionHash}`
          : null,
      }));
  }
}
