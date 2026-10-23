import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type Stripe from 'stripe';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { cooldownKey } from '../../../../libs/chain/src/service-limiter';
import { DAY_MS } from '../../../../libs/core/src/time';
import { PrismaService, type Prisma } from '../../../../libs/db/src';
import { REDIS } from '../../../../libs/redis/src';
import { StripeClient, applyIntent } from '../../../../libs/stripe/src';

const STALE_AFTER_MS = 3 * 60_000;
const RECHECK_AFTER_MS = 5 * 60_000;
const LOOKUPS_PER_RUN = 20;

/**
 * Catches up on card payments whose webhook never arrived. It reads from Stripe the payments
 * still `sent` or `processing` after a few minutes, and searches for charges on card orders that
 * were tried but have no payment row, then applies each PaymentIntent as the webhook would.
 * Each row is checked at most once every few minutes, least recently checked first, so rows
 * Stripe keeps reporting unchanged take turns with newer ones. A lookup Stripe refuses is
 * recorded once and skipped; a transient error or rate limit ends the run.
 */
@Injectable()
export class CardReconcilerService {
  constructor(
    private readonly db: PrismaService,
    private readonly stripe: StripeClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async run(now: Date): Promise<void> {
    if ((await this.redis.pttl(cooldownKey('stripe'))) > 0) return;
    const stale = new Date(now.getTime() - STALE_AFTER_MS);
    const due = {
      OR: [
        { reconciledAt: null },
        { reconciledAt: { lt: new Date(now.getTime() - RECHECK_AFTER_MS) } },
      ],
    };
    const leastRecentlyChecked = {
      reconciledAt: { sort: 'asc', nulls: 'first' },
    } as const;
    const payments = await this.db.payment.findMany({
      where: {
        provider: 'stripe',
        stage: { in: ['sent', 'processing'] },
        AND: [
          {
            OR: [
              { processingAt: { lt: stale } },
              { processingAt: null, sentAt: { lt: stale } },
            ],
          },
          due,
        ],
      },
      orderBy: [leastRecentlyChecked, { sentAt: 'asc' }],
      take: LOOKUPS_PER_RUN,
      select: { id: true, externalKey: true },
    });
    for (const { id, externalKey } of payments) {
      const intents = await this.lookUp(async () => [
        await this.stripe.retrieve(externalKey),
      ]);
      await this.db.$transaction(async (tx) => {
        await this.apply(tx, intents, now, {
          paymentId: id,
          whatHappened: `Card payment ${externalKey} could not be read from Stripe.`,
        });
        await tx.payment.update({
          where: { id },
          data: { reconciledAt: now },
        });
      });
    }
    if (payments.length >= LOOKUPS_PER_RUN) return;
    const orders = await this.db.order.findMany({
      where: {
        rail: 'card',
        sendAttempts: { gt: 0 },
        payments: { none: {} },
        createdAt: { lt: stale, gte: new Date(now.getTime() - DAY_MS) },
        AND: [
          {
            OR: [
              { sendState: 'review' },
              { sendState: { in: ['failed', 'pending'] }, status: 'expired' },
            ],
          },
          due,
        ],
      },
      orderBy: [leastRecentlyChecked, { createdAt: 'asc' }],
      take: LOOKUPS_PER_RUN - payments.length,
      select: { id: true },
    });
    for (const { id } of orders) {
      const intents = await this.lookUp(() => this.stripe.search(id));
      await this.db.$transaction(async (tx) => {
        await this.apply(tx, intents, now, {
          paymentId: null,
          whatHappened: `Card order ${id} could not be searched at Stripe.`,
        });
        await tx.order.update({
          where: { id },
          data: { reconciledAt: now },
        });
      });
    }
  }

  /** The PaymentIntents found, or null when Stripe refused the lookup for good. */
  private async lookUp(
    read: () => Promise<Stripe.PaymentIntent[]>,
  ): Promise<Stripe.PaymentIntent[] | null> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof RpcError && error.kind === 'permanent') return null;
      throw error;
    }
  }

  private async apply(
    tx: Prisma.TransactionClient,
    intents: Stripe.PaymentIntent[] | null,
    now: Date,
    refused: { paymentId: string | null; whatHappened: string },
  ): Promise<void> {
    if (intents) {
      for (const intent of intents) await applyIntent(tx, intent, now);
      return;
    }
    const where = { kind: 'reconcile_failed', ...refused };
    if (await tx.incident.findFirst({ where })) return;
    await tx.incident.create({
      data: {
        ...where,
        howHandled: 'Changed nothing; reconciliation checks it again later.',
      },
    });
  }
}
