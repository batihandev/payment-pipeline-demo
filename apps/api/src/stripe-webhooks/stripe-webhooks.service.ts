import { Injectable } from '@nestjs/common';
import type Stripe from 'stripe';
import type { Order, Payment } from '../../../../libs/db/generated/client';
import { PrismaService, type Prisma } from '../../../../libs/db/src';
import { savePaymentEvent } from '../../../../libs/events/src/save-payment-event';
import {
  BEFORE_PROCESSING,
  BEFORE_SETTLED,
} from '../../../../libs/orders/src/card-stages';
import { failCardPayment } from '../../../../libs/orders/src/fail-card-payment';
import { lockOrder } from '../../../../libs/orders/src/lock-order';
import { settlePayment } from '../../../../libs/orders/src/settle-payment';
import { InjectNow, type Now } from '../common/clock.module';

const INTENT_EVENTS = [
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
] as const;
const CENTS = 10000n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      if (stored.count === 0) {
        await this.recordDuplicate(tx, intent.id);
        return;
      }
      const locked = await this.lockPayment(tx, intent);
      if (!locked) {
        await tx.incident.create({
          data: {
            kind: 'unmatched',
            whatHappened: `Card payment ${intent.id} matches no card order.`,
            howHandled: 'Stored the event and changed nothing.',
          },
        });
        return;
      }
      await this.apply(tx, event, intent, locked);
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

  /**
   * Finds or creates the payment for the PaymentIntent and returns it row-locked. Returns null,
   * changing nothing, unless the intent names a card order with its amount in USD and the order
   * has no other PaymentIntent.
   */
  private async lockPayment(
    tx: Prisma.TransactionClient,
    intent: Stripe.PaymentIntent,
  ): Promise<{ payment: Payment & { orderId: string }; order: Order } | null> {
    const orderId = intent.metadata?.orderId;
    if (!orderId || !UUID.test(orderId)) return null;
    // The buyer locks the order before it writes the payment, so both sides agree on the order.
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { payments: { where: { provider: 'stripe' } } },
    });
    if (
      !order ||
      order.rail !== 'card' ||
      intent.currency !== 'usd' ||
      intent.amount !== Number(order.price / CENTS) ||
      order.payments.some((payment) => payment.externalKey !== intent.id)
    )
      return null;
    const payment = await tx.payment.upsert({
      where: {
        provider_externalKey: { provider: 'stripe', externalKey: intent.id },
      },
      create: {
        provider: 'stripe',
        externalKey: intent.id,
        orderId,
        amount: order.expectedAmount,
        stage: 'sent',
        sentAt: this.now(),
      },
      update: {},
    });
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id}::uuid FOR UPDATE`;
    return {
      payment: {
        ...(await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })),
        orderId,
      },
      order,
    };
  }

  private async apply(
    tx: Prisma.TransactionClient,
    event: IntentEvent,
    intent: Stripe.PaymentIntent,
    {
      payment,
      order,
    }: { payment: Payment & { orderId: string }; order: Order },
  ): Promise<void> {
    const now = this.now();
    if (event.type === 'payment_intent.processing') {
      if (!BEFORE_PROCESSING.includes(payment.stage)) return;
      await savePaymentEvent(
        tx,
        await tx.payment.update({
          where: { id: payment.id },
          data: { stage: 'processing', processingAt: now },
        }),
      );
    } else if (event.type === 'payment_intent.succeeded') {
      if (!BEFORE_SETTLED.includes(payment.stage)) return;
      await settlePayment(tx, payment, now, {
        final: true,
        finalAt: now,
        processingAt: payment.processingAt ?? now,
        receiptUrl: receiptUrlOf(intent) ?? payment.receiptUrl,
      });
      if (order.status === 'expired' || order.expiresAt < now)
        await tx.incident.create({
          data: {
            kind: 'paid_after_expiry',
            paymentId: payment.id,
            whatHappened: 'Order paid after expiry.',
            howHandled: 'Settled the late card payment.',
          },
        });
    } else {
      if (!BEFORE_SETTLED.includes(payment.stage)) return;
      await failCardPayment(tx, payment, now, 'The test card payment failed.');
    }
  }
}

function receiptUrlOf(intent: Stripe.PaymentIntent): string | null {
  const charge = intent.latest_charge;
  return typeof charge === 'object' && charge !== null
    ? (charge.receipt_url ?? null)
    : null;
}
