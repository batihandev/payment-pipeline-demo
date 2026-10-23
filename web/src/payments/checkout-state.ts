import { failedNote } from './notes';
import type { Payment, Snapshot } from './types';
import type { OrderStatus } from './use-order-status';
import { paymentFailed } from './view';

/** How long a card payment may stay processing before the checkout stops waiting for it. */
export const PROCESSING_BOUND_MS = 2 * 60_000;
export const stillProcessingNote =
  'Still processing at Stripe. It will appear in the feed when it settles.';

/** When a processing payment outlasts the bound, or null for any other payment. */
export function processingDeadline(
  payment: Pick<Payment, 'stage' | 'processingAt'> | undefined,
): number | null {
  if (payment?.stage !== 'processing' || !payment.processingAt) return null;
  return Date.parse(payment.processingAt) + PROCESSING_BOUND_MS;
}

/**
 * Where the visitor's purchase stands. A purchase is closed when its payment did not go
 * through, or its order closed before any payment was sent; the rail buttons then reopen.
 * They also reopen, without closing the purchase, once the payment has been processing for
 * longer than the bound.
 */
export function checkoutState({
  status,
  orderId,
  payment,
  paid,
  order,
  sending,
  message,
  now,
}: {
  status: Snapshot['status'];
  orderId: string | undefined;
  payment: Payment | undefined;
  paid: boolean;
  order: OrderStatus;
  sending: boolean;
  message: string;
  now: number;
}) {
  const closed =
    Boolean(orderId) &&
    !paid &&
    (payment ? paymentFailed(payment) : order.closed);
  const deadline = processingDeadline(payment);
  const stillProcessing = !closed && deadline !== null && now > deadline;
  const inProgress = Boolean(orderId) && !paid && !closed && !stillProcessing;
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
          : stillProcessing
            ? stillProcessingNote
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
