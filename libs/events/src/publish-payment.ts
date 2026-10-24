import type { Redis } from 'ioredis';
import type { Payment } from '../../db/generated/client';
import { bigintReplacer } from '@app/core/json';
import { publicPayment } from './public-payment';
export const paymentChannel = 'payments';
export function serializePayment(payment: Payment): string {
  return JSON.stringify(publicPayment(payment), bigintReplacer);
}
export async function publishPayment(
  redis: Pick<Redis, 'publish'>,
  payment: Payment,
): Promise<void> {
  await redis.publish(paymentChannel, serializePayment(payment));
}
