import type { Payment } from '../../db/generated/client';
import type { Prisma } from '../../db/src';
import { savePaymentEvent } from '../../events/src/save-payment-event';
import { closeOrder } from './close-order';
import { recordIncident } from '../../db/src';

/**
 * Moves a card payment to the terminal `failed` stage, closes its order unless it is closed
 * already, and records one `card_failed` incident for the order. The caller holds the order's
 * row lock.
 */
export async function failCardPayment(
  tx: Prisma.TransactionClient,
  payment: Payment & { orderId: string },
  now: Date,
  whatHappened: string,
): Promise<void> {
  await savePaymentEvent(
    tx,
    await tx.payment.update({
      where: { id: payment.id },
      data: { stage: 'failed', final: true, finalAt: now },
    }),
  );
  const order = await tx.order.findUniqueOrThrow({
    where: { id: payment.orderId },
  });
  if (order.sendState !== 'failed') await closeOrder(tx, order);
  const recorded = await tx.incident.findFirst({
    where: { kind: 'card_failed', payment: { orderId: order.id } },
  });
  if (!recorded)
    await recordIncident(tx, {
      kind: 'card_failed',
      paymentId: payment.id,
      whatHappened,
      howHandled: 'Closed the order; nothing was credited.',
    });
}
