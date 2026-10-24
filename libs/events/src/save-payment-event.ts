import type { Payment } from '../../db/generated/client';
import type { Prisma } from '@app/db';
import { serializePayment } from './publish-payment';
export async function savePaymentEvent(
  tx: Prisma.TransactionClient,
  payment: Payment,
): Promise<void> {
  await tx.paymentEvent.create({
    data: { paymentId: payment.id, body: serializePayment(payment) },
  });
}
