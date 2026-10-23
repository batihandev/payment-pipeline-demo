import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type Stripe from 'stripe';
import { cooldownKey } from '../../../../libs/chain/src/service-limiter';
import { DAY_MS } from '../../../../libs/core/src/time';
import { PrismaService } from '../../../../libs/db/src';
import { REDIS } from '../../../../libs/redis/src';
import { StripeClient, applyIntent } from '../../../../libs/stripe/src';

const STALE_AFTER_MS = 3 * 60_000;
const LOOKUPS_PER_RUN = 20;

/**
 * Catches up on card payments whose webhook never arrived. It reads from Stripe the payments
 * still `sent` or `processing` after a few minutes, and searches for charges on card orders that
 * were tried but have no payment row, then applies each PaymentIntent as the webhook would.
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
    const payments = await this.db.payment.findMany({
      where: {
        provider: 'stripe',
        stage: { in: ['sent', 'processing'] },
        OR: [
          { processingAt: { lt: stale } },
          { processingAt: null, sentAt: { lt: stale } },
        ],
      },
      orderBy: { sentAt: 'asc' },
      take: LOOKUPS_PER_RUN,
      select: { externalKey: true },
    });
    for (const { externalKey } of payments)
      await this.apply([await this.stripe.retrieve(externalKey)], now);
    if (payments.length >= LOOKUPS_PER_RUN) return;
    const orders = await this.db.order.findMany({
      where: {
        rail: 'card',
        sendAttempts: { gt: 0 },
        payments: { none: {} },
        createdAt: { lt: stale, gte: new Date(now.getTime() - DAY_MS) },
        OR: [
          { sendState: 'review' },
          { sendState: 'failed', status: 'expired' },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: LOOKUPS_PER_RUN - payments.length,
      select: { id: true },
    });
    for (const { id } of orders)
      await this.apply(await this.stripe.search(id), now);
  }

  private async apply(intents: Stripe.PaymentIntent[], now: Date) {
    for (const intent of intents)
      await this.db.$transaction((tx) => applyIntent(tx, intent, now));
  }
}
