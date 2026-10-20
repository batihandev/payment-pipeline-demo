import type { Payment } from '../../../libs/db/generated/client';
import type { Prisma } from '../../../libs/db/src';
import { serializePayment } from '../../../libs/events/src/publish-payment';
export async function savePaymentEvent(
  tx: Prisma.TransactionClient,
  payment: Payment,
): Promise<void> {
  await tx.paymentEvent.create({
    data: { paymentId: payment.id, body: serializePayment(payment) },
  });
}
