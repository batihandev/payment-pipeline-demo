import type { Prisma } from '../../db/src';

/** Row-locks an order until the transaction ends, so its writers take turns. */
export async function lockOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
}
