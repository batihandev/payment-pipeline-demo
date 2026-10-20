import type { Payment } from '../../db/generated/client';
import type { Prisma } from '../../db/src';
import { serializePayment } from './publish-payment';
export async function savePaymentEvent(
  tx: Prisma.TransactionClient,
  payment: Payment,
): Promise<void> {
  await tx.paymentEvent.create({
    data: { paymentId: payment.id, body: serializePayment(payment) },
  });
}
