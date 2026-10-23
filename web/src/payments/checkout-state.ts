import { failedNote } from './notes';
import type { Payment, Snapshot } from './types';
import type { OrderStatus } from './use-order-status';
import { paymentFailed } from './view';

/** How long a card payment may stay processing before the checkout stops waiting for it. */
export const PROCESSING_BOUND_MS = 2 * 60_000;
export const stillProcessingNote =
  'Still processing at Stripe. It will appear in the feed when it settles.';

/** How long past its expiry an order with no payment may stay open before the checkout stops waiting. */
export const ORDER_CLOSE_MARGIN_MS = 2 * 60_000;
export const pastExpiryNote =
  'This order is past its expiry. If it was paid, the payment will appear in the feed.';

/** When a processing payment outlasts the bound, or null for any other payment. */
export function processingDeadline(
  payment: Pick<Payment, 'stage' | 'processingAt'> | undefined,
): number | null {
  if (payment?.stage !== 'processing' || !payment.processingAt) return null;
  return Date.parse(payment.processingAt) + PROCESSING_BOUND_MS;
}

/**
 * When the checkout stops waiting: the processing bound once a payment exists, otherwise the
 * order's expiry plus a margin, or null when neither is known.
 */
export function checkoutDeadline({
  payment,
  expiresAt,
}: {
  payment: Pick<Payment, 'stage' | 'processingAt'> | undefined;
  expiresAt: string | undefined;
}): number | null {
  if (payment) return processingDeadline(payment);
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return Number.isNaN(expiry) ? null : expiry + ORDER_CLOSE_MARGIN_MS;
}

/**
 * Where the visitor's purchase stands. A purchase is closed when its payment did not go
 * through, or its order closed before any payment was sent; the rail buttons then reopen.
 * They also reopen, without closing the purchase, once the payment has been processing for
 * longer than the bound, or once an order with no payment is well past its expiry without a
 * close arriving.
 */
export function checkoutState({
  status,
  orderId,
  expiresAt,
  payment,
  paid,
  order,
  sending,
  message,
  now,
}: {
  status: Snapshot['status'];
  orderId: string | undefined;
  expiresAt?: string;
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
  const deadline = checkoutDeadline({ payment, expiresAt });
  const overdue = !closed && deadline !== null && now > deadline;
  const inProgress = Boolean(orderId) && !paid && !closed && !overdue;
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
          : overdue
            ? payment
              ? stillProcessingNote
              : pastExpiryNote
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
