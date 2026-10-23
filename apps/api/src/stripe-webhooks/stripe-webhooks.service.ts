import { Injectable } from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService, type Prisma } from '../../../../libs/db/src';
import { applyIntent } from '../../../../libs/stripe/src';
import { InjectNow, type Now } from '../common/clock.module';

const INTENT_EVENTS = [
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
] as const;

type IntentEvent = Stripe.Event & {
  type: (typeof INTENT_EVENTS)[number];
  data: { object: Stripe.PaymentIntent };
};

const isIntentEvent = (event: Stripe.Event): event is IntentEvent =>
  (INTENT_EVENTS as readonly string[]).includes(event.type);

@Injectable()
export class StripeWebhooksService {
  constructor(
    private readonly db: PrismaService,
    @InjectNow() private readonly now: Now,
  ) {}

  /** Stores the event once and applies it to the card payment it names, all in one transaction. */
  async handle(event: Stripe.Event): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const stored = await tx.stripeEvent.createMany({
        data: [{ id: event.id, type: event.type }],
        skipDuplicates: true,
      });
      if (!isIntentEvent(event)) {
        if (stored.count === 0) await this.recordDuplicate(tx, null);
        return;
      }
      const intent = event.data.object;
      if (stored.count === 0) await this.recordDuplicate(tx, intent.id);
      else await applyIntent(tx, intent, this.now());
    });
  }

  private async recordDuplicate(
    tx: Prisma.TransactionClient,
    intentId: string | null,
  ): Promise<void> {
    const payment = intentId
      ? await tx.payment.findUnique({
          where: {
            provider_externalKey: { provider: 'stripe', externalKey: intentId },
          },
        })
      : null;
    await tx.incident.create({
      data: {
        kind: 'duplicate',
        paymentId: payment?.id,
        whatHappened: 'Stripe event delivered again.',
        howHandled: 'Skipped the duplicate event.',
      },
    });
  }
}
