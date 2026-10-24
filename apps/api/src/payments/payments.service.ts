import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Subscription } from 'rxjs';
import { EventsService } from '../events/events.service';
import { Prisma, PrismaService } from '@app/db';
import type { PaymentCursor } from '@app/core/payment-cursor';
import { PAYMENT_LIST_STEP } from '@app/core/payment-list';
import type { PaymentListItemRecord } from '@app/core/api';
import { publicPayment } from '@app/events/public-payment';
import { isReceiptNoteKind, receiptNoteKinds } from '@app/core/receipt-notes';
import type { ApiConfig } from '../common/api-config';
import { InjectNow, type Now } from '../common/clock.module';
import { ttlCache } from '../common/ttl-cache';
import { explorerUrl } from '../common/explorer-url';

const CACHE_MS = 5000;

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly cached = new Map<
    number,
    () => Promise<PaymentListItemRecord[]>
  >();

  private subscription?: Subscription;

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<ApiConfig, true>,
    @InjectNow() private readonly now: Now,
    private readonly events: EventsService,
  ) {}

  /** A page refetches after each live event, so a cached list must never predate one. */
  onModuleInit(): void {
    this.subscription = this.events.paymentChanged.subscribe(() => {
      this.cached.clear();
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /**
   * Only first pages whose limit is a multiple of 20, or one more than one, are cached: the page
   * reads one row past its window to learn whether older rows exist. Validation allows limits
   * from 1 to 200, so the cache holds at most 19 keys. Other limits, and pages before a cursor,
   * are read when asked for.
   */
  list(
    limit: number,
    before: PaymentCursor | null = null,
  ): Promise<PaymentListItemRecord[]> {
    const step = limit % PAYMENT_LIST_STEP;
    if (before || !(step === 0 || (step === 1 && limit > PAYMENT_LIST_STEP)))
      return this.query(limit, before);
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

  private async query(
    limit: number,
    before: PaymentCursor | null = null,
  ): Promise<PaymentListItemRecord[]> {
    const donationMin = this.config.get('DONATION_MIN', { infer: true });
    const explorer = this.config.get('BLOCK_EXPLORER_URL', { infer: true });
    const ids = await this.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM payments WHERE NOT (donation AND amount < ${donationMin}) ${olderThan(before)} ORDER BY COALESCE(sent_at, received_at) DESC NULLS LAST, id DESC LIMIT ${limit}`;
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
            customer: { select: { cardBrand: true, cardLast4: true } },
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
        noteKinds: incidents
          .map((incident) => incident.kind)
          .filter(isReceiptNoteKind),
        explorerUrl: explorerUrl(explorer, row.transactionHash),
      }));
  }
}

/** The rows after `cursor` in the feed's order, where a row with no time sorts last. */
function olderThan(cursor: PaymentCursor | null): Prisma.Sql {
  if (!cursor) return Prisma.empty;
  const at = Prisma.sql`COALESCE(sent_at, received_at)`;
  return cursor.at === null
    ? Prisma.sql`AND ${at} IS NULL AND id < ${cursor.id}::uuid`
    : Prisma.sql`AND (${at} < ${cursor.at}::timestamptz OR (${at} = ${cursor.at}::timestamptz AND id < ${cursor.id}::uuid) OR ${at} IS NULL)`;
}
