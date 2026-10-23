import { useEffect, useState } from 'react';
import type { OrderUpdate, PaymentsClient } from './client';
import { paymentsClient } from './use-payments';

/** Where a visitor's order stands: its place in the queue, and whether it closed unsent. */
export type OrderStatus = { position: number; closed: boolean };

function readStatus(body: unknown): OrderStatus | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { position, closed } = body as Record<string, unknown>;
  if (typeof position !== 'number') return undefined;
  return { position, closed: closed === true };
}

/**
 * Follows an order on the event stream. `GET /test-purchases/:id` is read once at the start and
 * again each time the stream opens, to catch up on updates it may have missed; nothing is read
 * on a timer. A closed order stays closed.
 */
export function followOrder({
  client,
  orderId,
  request = fetch,
  onStatus,
}: {
  client: Pick<PaymentsClient, 'baseUrl' | 'onOrderUpdate'>;
  orderId: string;
  request?: typeof fetch;
  onStatus: (status: OrderStatus) => void;
}): () => void {
  const controller = new AbortController();
  let stopped = false;
  let status: OrderStatus = { position: 0, closed: false };
  const show = (next: OrderStatus) => {
    if (stopped) return;
    status = { ...next, closed: next.closed || status.closed };
    onStatus(status);
  };
  async function read() {
    try {
      const response = await request(
        `${client.baseUrl}/test-purchases/${orderId}`,
        { signal: controller.signal },
      );
      const read = response.ok ? readStatus(await response.json()) : undefined;
      if (read) show(read);
    } catch {
      // the next stream open reads it again
    }
  }
  const stopListening = client.onOrderUpdate((update: OrderUpdate) => {
    if (update.type === 'opened') void read();
    else if (update.type === 'queue')
      show({ ...status, position: update.waiting.indexOf(orderId) + 1 });
    else if (update.id === orderId && update.closed)
      show({ position: 0, closed: true });
  });
  void read();
  return () => {
    stopped = true;
    stopListening();
    controller.abort();
  };
}

/** Follows a visitor's order until it is paid; `paid` stops following it. */
export function useOrderStatus(
  apiBaseUrl: string,
  orderId: string | null,
  initialPosition: number,
  paid: boolean,
): OrderStatus {
  const [followed, setFollowed] = useState<{
    orderId: string;
    status: OrderStatus;
  }>();
  useEffect(() => {
    if (!orderId || paid) return;
    return followOrder({
      client: paymentsClient(apiBaseUrl),
      orderId,
      onStatus: (status) => {
        setFollowed({ orderId, status });
      },
    });
  }, [apiBaseUrl, orderId, paid]);
  if (!orderId || paid) return { position: 0, closed: false };
  return followed?.orderId === orderId
    ? followed.status
    : { position: initialPosition, closed: false };
}
