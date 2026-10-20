import type { PrismaClient } from '../../../libs/db/src';
export async function expireOrders(
  db: PrismaClient,
  now: Date,
): Promise<number> {
  const result = await db.order.updateMany({
    where: { status: 'open', expiresAt: { lte: now } },
    data: { status: 'expired' },
  });
  return result.count;
}
