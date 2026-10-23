import { BudgetReservation, type Prisma } from '../../db/src';

type ClosableOrder = {
  id: string;
  source: 'schedule' | 'visitor';
  createdAt: Date;
  expectedAmount: bigint;
};

/** Marks an unpaid order failed and expired, and gives a scheduled order's budget back. */
export async function closeOrder(
  tx: Prisma.TransactionClient,
  order: ClosableOrder,
): Promise<void> {
  // An interactive transaction runs one query at a time, so these run in turn.
  await tx.order.update({
    where: { id: order.id },
    data: { sendState: 'failed', status: 'expired' },
  });
  if (order.source === 'schedule')
    await new BudgetReservation(tx).release(
      order.createdAt,
      order.expectedAmount,
    );
}
