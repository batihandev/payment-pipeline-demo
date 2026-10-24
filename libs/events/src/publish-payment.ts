import type { Redis } from 'ioredis';
import type { Payment } from '../../db/generated/client';
import { bigintReplacer } from '@app/core/json';
import { publicPayment, type OrderRow } from './public-payment';
export const paymentChannel = 'payments';
/** A payment with its order when it was read with one; events always carry the order, or null without one. */
type PaymentWithOrder = Payment & { order?: OrderRow | null };
export function serializePayment(payment: PaymentWithOrder): string {
  return JSON.stringify(publicPayment(payment), bigintReplacer);
}
export async function publishPayment(
  redis: Pick<Redis, 'publish'>,
  payment: PaymentWithOrder,
): Promise<void> {
  await redis.publish(paymentChannel, serializePayment(payment));
}
