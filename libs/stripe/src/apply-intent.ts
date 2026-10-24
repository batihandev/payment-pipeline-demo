import type Stripe from 'stripe';
import type { Order, Payment } from '../../db/generated/client';
import { BudgetReservation, type Prisma, recordIncident } from '@app/db';
import { savePaymentEvent } from '@app/events/save-payment-event';
import { BEFORE_PROCESSING, BEFORE_SETTLED } from '@app/orders/card-stages';
import { failCardPayment } from '@app/orders/fail-card-payment';
import { lockOrder } from '@app/orders/lock-order';
import { settlePayment } from '@app/orders/settle-payment';

const CENTS = 10000n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrderPayment = Payment & { orderId: string };

export type IntentOutcome = 'applied' | 'unchanged' | 'unmatched';

/**
 * Applies a PaymentIntent's status to the card payment it names: `processing` moves the payment
 * to processing, `succeeded` settles it, and a failed or canceled intent fails it. A stage never
 * moves backwards. An intent that does not match its card order changes nothing and is recorded
 * as `unmatched`.
 */
export async function applyIntent(
  tx: Prisma.TransactionClient,
  intent: Stripe.PaymentIntent,
  now: Date,
): Promise<IntentOutcome> {
  const locked = await lockPayment(tx, intent, now);
  if (!locked) {
    await recordIncident(tx, {
      kind: 'unmatched',
      whatHappened: `Card payment ${intent.id} matches no card order.`,
      howHandled: 'Stored the event and changed nothing.',
    });
    return 'unmatched';
  }
  const { payment, order } = locked;
  switch (intent.status) {
    case 'processing':
      if (!BEFORE_PROCESSING.includes(payment.stage)) return 'unchanged';
      await savePaymentEvent(
        tx,
        await tx.payment.update({
          where: { id: payment.id },
          data: { stage: 'processing', processingAt: now },
        }),
      );
      return 'applied';
    case 'succeeded':
      if (!BEFORE_SETTLED.includes(payment.stage)) return 'unchanged';
      await settlePayment(tx, payment, now, {
        final: true,
        finalAt: now,
        processingAt: payment.processingAt ?? now,
        receiptUrl: receiptUrlOf(intent) ?? payment.receiptUrl,
      });
      if (order.status === 'expired' || order.expiresAt < now)
        await recordIncident(tx, {
          kind: 'paid_after_expiry',
          paymentId: payment.id,
          whatHappened: 'Order paid after expiry.',
          howHandled: 'Settled the late card payment.',
        });
      // Closing a scheduled order gave its budget back; the late payment spends it again.
      if (order.source === 'schedule' && order.sendState === 'failed')
        await new BudgetReservation(tx).restore(
          order.createdAt,
          order.expectedAmount,
        );
      return 'applied';
    case 'requires_payment_method':
    case 'canceled':
      if (!BEFORE_SETTLED.includes(payment.stage)) return 'unchanged';
      await failCardPayment(tx, payment, now, 'The test card payment failed.');
      return 'applied';
    default:
      return 'unchanged';
  }
}

/**
 * Finds or creates the payment for the PaymentIntent and returns it row-locked. Returns null,
 * changing nothing, unless the intent names a card order with its amount in USD and the order
 * has no other PaymentIntent.
 */
async function lockPayment(
  tx: Prisma.TransactionClient,
  intent: Stripe.PaymentIntent,
  now: Date,
): Promise<{ payment: OrderPayment; order: Order } | null> {
  const orderId = intent.metadata.orderId;
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
      sentAt: now,
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

function receiptUrlOf(intent: Stripe.PaymentIntent): string | null {
  const charge = intent.latest_charge;
  return typeof charge === 'object' && charge !== null
    ? (charge.receipt_url ?? null)
    : null;
}
