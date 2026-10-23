import { useRef, useState } from 'react';
import { CardTerminal } from './card-terminal';
import { ChainTerminal } from './chain-terminal';
import type { Rail } from './client';
import { RailChoice } from './rail-choice';
import { Receipt } from './receipt';
import { paymentsClient, usePayments } from './use-payments';
import { useQueuePosition } from './use-queue-position';
import { useStageSequence } from './use-stage-sequence';
import {
  cardAvailable,
  confirmationsNeeded,
  money,
  purchaseMessage,
  stageView,
} from './view';
import './styles.css';
import './checkout.css';

export function Checkout({
  apiBaseUrl,
  repoUrl,
  onOrder,
}: {
  apiBaseUrl: string;
  repoUrl?: string;
  onOrder?: (orderId: string) => void;
}) {
  const { data, status } = usePayments(apiBaseUrl);
  const [opened, setOpened] = useState(false);
  const [sending, setSending] = useState(false);
  const [orderId, setOrderId] = useState<string>();
  const [rail, setRail] = useState<Rail>();
  const [message, setMessage] = useState('');
  const [accepted, setAccepted] = useState(0);
  const inFlight = useRef(false);
  const [ordered, setOrdered] = useState<{ item: string; price: string }>();
  const latest = data?.payments.find((p) => p.orderId === orderId);
  const frame = useStageSequence(latest);
  const payment = latest && frame ? { ...latest, ...frame } : undefined;
  const threshold = confirmationsNeeded(data?.health ?? null);
  const view = payment ? stageView(payment, threshold) : null;
  const item = ordered?.item ?? latest?.order?.item;
  const price = ordered?.price ?? latest?.order?.price ?? latest?.amount;
  const position = useQueuePosition(
    apiBaseUrl,
    orderId ?? null,
    accepted,
    Boolean(payment),
  );
  const active = Boolean(orderId && !view?.paid);

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
  return (
    <section className="tp tp-checkout" aria-labelledby="checkout-title">
      <div className="tp-counter-heading">
        <span className="tp-counter-label tp-mono">THE TEST SHOP</span>
        <h2 id="checkout-title">Try a test purchase</h2>
        <p>A small purchase. A real payment trail.</p>
      </div>
      <p className="tp-disclosure">
        Test purchase · no real money · paid from the demo’s own test account
      </p>
      {status === 'offline' && <p role="status">Demo offline</p>}
      {!opened ? (
        <button
          type="button"
          disabled={status !== 'live'}
          onClick={() => setOpened(true)}
        >
          Open the counter
        </button>
      ) : (
        <div className="tp-drawer">
          <h3>How would you like to pay?</h3>
          <p className="tp-muted">
            The shop chooses an item when your order is accepted.
          </p>
          <RailChoice
            cardAvailable={cardAvailable(data?.health ?? null)}
            disabled={sending || active || status !== 'live'}
            chosen={rail}
            busyLabel={
              sending
                ? 'Placing your order…'
                : active
                  ? 'Your purchase is in progress'
                  : undefined
            }
            onChoose={(chosen) => {
              void purchase(chosen);
            }}
          />
          <div role="status" className="tp-purchase-status">
            {status === 'offline'
              ? 'Demo offline'
              : message ||
                (position > 1 && !payment
                  ? `Queued · ${position - 1} ahead`
                  : sending
                    ? 'Requesting a test purchase…'
                    : orderId && !payment
                      ? 'Order accepted. Waiting for the payment to be sent.'
                      : status === 'loading'
                        ? 'Connecting to the demo…'
                        : '')}
          </div>
          {item && price && (
            <div className="tp-item" key={orderId}>
              <span className="tp-mono">YOUR ITEM</span>
              <strong>{item}</strong>
              <span className="tp-price">{money(price)}</span>
            </div>
          )}
          {payment && view && (
            <>
              {payment.provider === 'stripe' ? (
                <CardTerminal payment={payment} />
              ) : (
                <ChainTerminal payment={payment} threshold={threshold} />
              )}
              {view.paid && (
                <div className="tp-printed-receipt">
                  <Receipt
                    payment={payment}
                    threshold={threshold}
                    highlighted
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
      {repoUrl && (
        <a className="tp-how" href={repoUrl} target="_blank" rel="noreferrer">
          How this works
        </a>
      )}
    </section>
  );
}
