import { didNotGoThrough, failedNote } from './notes';
import type { Payment, Snapshot } from './types';
import type { OrderStatus } from './use-order-status';

/**
 * Where the visitor's purchase stands. A purchase is closed when its payment did not go
 * through, or its order closed before any payment was sent; the rail buttons then reopen.
 */
export function checkoutState({
  status,
  orderId,
  payment,
  paid,
  order,
  sending,
  message,
}: {
  status: Snapshot['status'];
  orderId: string | undefined;
  payment: Payment | undefined;
  paid: boolean;
  order: OrderStatus;
  sending: boolean;
  message: string;
}) {
  const closed =
    Boolean(orderId) &&
    !paid &&
    (order.closed || (payment !== undefined && didNotGoThrough(payment)));
  const inProgress = Boolean(orderId) && !paid && !closed;
  return {
    busy: sending || inProgress,
    closed,
    busyLabel: sending
      ? 'Placing your order…'
      : inProgress
        ? 'Your purchase is in progress'
        : undefined,
    statusText:
      status === 'offline'
        ? 'Demo offline'
        : closed
          ? `${failedNote} You can try again.`
          : message ||
            (order.position > 1 && !payment
              ? `Queued · ${order.position - 1} ahead`
              : sending
                ? 'Requesting a test purchase…'
                : orderId && !payment
                  ? 'Order accepted. Waiting for the payment to be sent.'
                  : status === 'loading'
                    ? 'Connecting to the demo…'
                    : ''),
  };
}
