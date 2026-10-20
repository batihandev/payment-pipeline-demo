import type { Redis } from 'ioredis';
import type { Payment } from '../../db/generated/client';
export const paymentChannel = 'payments';
export function serializePayment(payment: Payment): string {
  return JSON.stringify(payment, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}
export async function publishPayment(
  redis: Pick<Redis, 'publish'>,
  payment: Payment,
): Promise<void> {
  await redis.publish(paymentChannel, serializePayment(payment));
}
