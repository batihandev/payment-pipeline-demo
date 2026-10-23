import { useRef, useState } from 'react';
import type { Rail } from './client';
import { paymentsClient } from './use-payments';
import { purchaseMessage } from './view';

/** A visitor's test purchase: sends it once at a time and holds what the API answered. */
export function usePurchase(
  apiBaseUrl: string,
  onOrder?: (orderId: string) => void,
) {
  const [sending, setSending] = useState(false);
  const [orderId, setOrderId] = useState<string>();
  const [rail, setRail] = useState<Rail>();
  const [message, setMessage] = useState('');
  /** The queue position the accept answer gave, until the stream says otherwise. */
  const [accepted, setAccepted] = useState(0);
  const [ordered, setOrdered] = useState<{ item: string; price: string }>();
  const [expiresAt, setExpiresAt] = useState<string>();
  const inFlight = useRef(false);

  async function purchase(chosen: Rail) {
    if (inFlight.current) return;
    inFlight.current = true;
    setRail(chosen);
    setSending(true);
    setMessage('');
    try {
      const client = paymentsClient(apiBaseUrl);
      const response = await client.purchase(chosen);
      const { body } = response;
      if (body.orderId) {
        setOrderId(body.orderId);
        setExpiresAt(body.expiresAt);
        setOrdered(
          body.item && body.price
            ? { item: body.item, price: body.price }
            : undefined,
        );
        setAccepted(response.ok ? (body.position ?? 0) : 0);
        onOrder?.(body.orderId);
        setMessage(
          response.ok
            ? ''
            : 'Your order was accepted. Sending is pending; please wait.',
        );
        await client.refresh();
      } else if (!response.ok)
        setMessage(
          purchaseMessage(response.status, body.error, response.retryAfter),
        );
      else setMessage('Demo offline');
    } catch {
      setMessage('Demo offline');
    } finally {
      setSending(false);
      inFlight.current = false;
    }
  }

  return {
    sending,
    orderId,
    rail,
    message,
    accepted,
    ordered,
    expiresAt,
    purchase,
  };
}
