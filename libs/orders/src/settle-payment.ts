import type { Payment } from '../../db/generated/client';
import type { Prisma } from '../../db/src';
import { savePaymentEvent } from '../../events/src/save-payment-event';

/**
 * Credits a payment once: the ledger entry, the `settled` stage with its event, and for an
 * order payment the shop notice and the order's `paid` status. `extra` is written with the
 * stage so a rail can set its own fields in the same update. The caller holds the payment's
 * row lock.
 */
export async function settlePayment(
  tx: Prisma.TransactionClient,
  payment: Payment,
  now: Date,
  extra: Prisma.PaymentUpdateInput = {},
): Promise<Payment> {
  await tx.ledgerEntry.create({
    data: { paymentId: payment.id, amount: payment.amount },
  });
  const settled = await tx.payment.update({
    where: { id: payment.id },
    data: { ...extra, stage: 'settled', settledAt: now },
  });
  await savePaymentEvent(tx, settled);
  if (settled.orderId) {
    await tx.notice.upsert({
      where: { paymentId: settled.id },
      create: { paymentId: settled.id },
      update: {},
    });
    await tx.order.update({
      where: { id: settled.orderId },
      data: { status: 'paid' },
    });
  }
  return settled;
}
