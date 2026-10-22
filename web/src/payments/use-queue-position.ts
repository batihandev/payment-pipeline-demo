import { useEffect, useState } from 'react';
import { paymentsClient } from './use-payments';

export const queuePollMs = 1000;

export function startQueuePolling({
  baseUrl,
  orderId,
  initialPosition,
  request = fetch,
  onPosition,
}: {
  baseUrl: string;
  orderId: string;
  initialPosition: number;
  request?: typeof fetch;
  onPosition: (position: number) => void;
}): () => void {
  const controller = new AbortController();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    let position: number | undefined;
    try {
      const response = await request(`${baseUrl}/test-purchases/${orderId}`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const body = (await response.json()) as { position?: unknown };
        if (typeof body.position === 'number') position = body.position;
      }
    } catch {
      // keep the last position and try again
    }
    if (cancelled) return;
    if (position !== undefined) {
      onPosition(position);
      if (position === 0) return;
    }
    timer = setTimeout(() => void poll(), queuePollMs);
  }
  if (initialPosition > 0) timer = setTimeout(() => void poll(), queuePollMs);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    controller.abort();
  };
}

export function useQueuePosition(
  apiBaseUrl: string,
  orderId: string | null,
  initialPosition: number,
  paid: boolean,
): number {
  const [polled, setPolled] = useState<{ orderId: string; position: number }>();
  useEffect(() => {
    if (!orderId || paid || initialPosition <= 0) return;
    return startQueuePolling({
      baseUrl: paymentsClient(apiBaseUrl).baseUrl,
      orderId,
      initialPosition,
      onPosition: (position) => setPolled({ orderId, position }),
    });
  }, [apiBaseUrl, orderId, initialPosition, paid]);
  if (!orderId || paid) return 0;
  return polled?.orderId === orderId ? polled.position : initialPosition;
}
