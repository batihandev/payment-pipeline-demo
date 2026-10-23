import { BudgetReservation, type Prisma } from '../../db/src';

type ClosableOrder = {
  id: string;
  source: 'schedule' | 'visitor';
  createdAt: Date;
  expectedAmount: bigint;
};

/** Marks an unpaid order failed and expired, and gives a scheduled order's budget back. */
export function closeOrder(
  tx: Prisma.TransactionClient,
  order: ClosableOrder,
): Promise<unknown> {
  return Promise.all([
    tx.order.update({
      where: { id: order.id },
      data: { sendState: 'failed', status: 'expired' },
    }),
    order.source === 'schedule'
      ? new BudgetReservation(tx).release(order.createdAt, order.expectedAmount)
      : undefined,
  ]);
}
