import type { Redis } from 'ioredis';
import type { Payment } from '../../db/generated/client';
export const paymentChannel = 'payments';
export async function publishPayment(
  redis: Pick<Redis, 'publish'>,
  payment: Payment,
): Promise<void> {
  await redis.publish(
    paymentChannel,
    JSON.stringify(payment, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}
