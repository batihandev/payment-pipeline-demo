import type { Order } from '../../db/generated/client';
import type { Prisma } from '../../db/src';
import type { OrderEvent } from '../../core/src/api';

export const orderChannel = 'orders';

type OrderState = Pick<Order, 'id' | 'status' | 'sendState'>;

/** An order closed without a payment being sent. */
export function orderClosed(
  order: Pick<Order, 'status' | 'sendState'>,
): boolean {
  return order.status === 'expired' && order.sendState !== 'sent';
}

export function serializeOrder(order: OrderState): string {
  const event: OrderEvent = {
    type: 'order',
    id: order.id,
    closed: orderClosed(order),
  };
  return JSON.stringify(event);
}

/**
 * Records that orders changed state. The tracker publishes each order's state once the
 * transaction has committed, as it does for payment events.
 */
export async function saveOrderEvents(
  tx: Prisma.TransactionClient,
  orderIds: string[],
): Promise<void> {
  if (orderIds.length)
    await tx.orderEvent.createMany({
      data: orderIds.map((orderId) => ({ orderId })),
    });
}
