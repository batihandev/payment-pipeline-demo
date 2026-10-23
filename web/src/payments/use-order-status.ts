import { useEffect, useState } from 'react';
import { paymentsClient } from './use-payments';

export const orderPollMs = 1000;

/** What `GET /test-purchases/:id` reports about a visitor's order. */
export type OrderStatus = { position: number; closed: boolean };

function readStatus(body: unknown): OrderStatus | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { position, closed } = body as Record<string, unknown>;
  if (typeof position !== 'number') return undefined;
  return { position, closed: closed === true };
}

/** Polls the order until it closes or the returned stop function is called. */
export function startOrderPolling({
  baseUrl,
  orderId,
  request = fetch,
  onStatus,
}: {
  baseUrl: string;
  orderId: string;
  request?: typeof fetch;
  onStatus: (status: OrderStatus) => void;
}): () => void {
  const controller = new AbortController();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    let status: OrderStatus | undefined;
    try {
      const response = await request(`${baseUrl}/test-purchases/${orderId}`, {
        signal: controller.signal,
      });
      if (response.ok) status = readStatus(await response.json());
    } catch {
      // keep the last status and try again
    }
    if (cancelled) return;
    if (status) {
      onStatus(status);
      if (status.closed) return;
    }
    timer = setTimeout(() => void poll(), orderPollMs);
  }
  timer = setTimeout(() => void poll(), orderPollMs);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    controller.abort();
  };
}

/** Follows a visitor's order until it is paid or closes; `paid` stops the polling. */
export function useOrderStatus(
  apiBaseUrl: string,
  orderId: string | null,
  initialPosition: number,
  paid: boolean,
): OrderStatus {
  const [polled, setPolled] = useState<{
    orderId: string;
    status: OrderStatus;
  }>();
  useEffect(() => {
    if (!orderId || paid) return;
    return startOrderPolling({
      baseUrl: paymentsClient(apiBaseUrl).baseUrl,
      orderId,
      onStatus: (status) => setPolled({ orderId, status }),
    });
  }, [apiBaseUrl, orderId, paid]);
  if (!orderId || paid) return { position: 0, closed: false };
  return polled?.orderId === orderId
    ? polled.status
    : { position: initialPosition, closed: false };
}
