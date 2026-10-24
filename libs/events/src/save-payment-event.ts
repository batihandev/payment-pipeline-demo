import type { Payment } from '../../db/generated/client';
import type { Prisma } from '@app/db';
import { publicOrderSelect } from './public-payment';
import { serializePayment } from './publish-payment';

/** Saves the payment's event with its order, read in the same transaction, as list reads show it. */
export async function savePaymentEvent(
  tx: Prisma.TransactionClient,
  payment: Payment,
): Promise<void> {
  const order = payment.orderId
    ? await tx.order.findUnique({
        where: { id: payment.orderId },
        select: publicOrderSelect,
      })
    : null;
  await tx.paymentEvent.create({
    data: {
      paymentId: payment.id,
      body: serializePayment({ ...payment, order }),
    },
  });
}
