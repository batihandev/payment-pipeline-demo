import { useRef, useState } from 'react';
import { paymentsClient, usePayments } from './use-payments';
import { ConfirmationBar, Receipt } from './receipt';
import { money, purchaseMessage, stageView } from './view';
import './styles.css';
import './checkout.css';

export function Checkout({
  apiBaseUrl,
  repoUrl = import.meta.env.VITE_REPO_URL,
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
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const payment = data?.payments.find((p) => p.orderId === orderId);
  const view =
    payment && data ? stageView(payment, data.health.confirmations) : null;
  const active = Boolean(orderId && !view?.paid);

  async function purchase() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setMessage('');
    try {
      const client = paymentsClient(apiBaseUrl);
      const response = await fetch(`${client.baseUrl}/test-purchases`, {
        method: 'POST',
      });
      const body = (await response.json()) as {
        orderId?: string;
        error?: string;
      };
      if (body.orderId) {
        setOrderId(body.orderId);
        onOrder?.(body.orderId);
        setMessage(
          response.ok
            ? ''
            : 'Your order was accepted. Sending is pending; please wait.',
        );
        await client.refresh();
      } else if (!response.ok)
        setMessage(
          purchaseMessage(response.status, response.headers.get('retry-after')),
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
      {!opened ? (
        <button type="button" onClick={() => setOpened(true)}>
          Open the counter
        </button>
      ) : (
        <div className="tp-drawer">
          <div className="tp-row tp-between">
            <h3>How would you like to pay?</h3>
            <span className="tp-network">Test network</span>
          </div>
          <p className="tp-muted">
            The shop chooses an item when your order is accepted.
          </p>
          <button
            type="button"
            disabled={sending || active || status !== 'live'}
            onClick={() => {
              void purchase();
            }}
          >
            {sending
              ? 'Placing your order…'
              : active
                ? 'Your purchase is in progress'
                : 'Pay with Test network'}
          </button>
          <div role="status" className="tp-purchase-status">
            {status === 'offline'
              ? 'Demo offline'
              : message ||
                (sending
                  ? 'Requesting a test purchase…'
                  : orderId && !payment
                    ? 'Order accepted. Waiting for the payment to be sent.'
                    : status === 'loading'
                      ? 'Connecting to the demo…'
                      : '')}
          </div>
          {payment && data && view && (
            <>
              <div className="tp-item" key={payment.id}>
                <span className="tp-mono">YOUR ITEM</span>
                <strong>
                  {payment.order?.item ?? 'Order details pending'}
                </strong>
                <span className="tp-price">
                  {money(payment.order?.price ?? payment.amount)}
                </span>
              </div>
              <div className="tp-terminal" aria-label="Payment terminal">
                <div className="tp-terminal-screen">
                  <span className="tp-mono">TEST NETWORK</span>
                  <strong key={payment.stage} className="tp-terminal-state">
                    {view.label}
                  </strong>
                  <ConfirmationBar
                    payment={payment}
                    threshold={data.health.confirmations}
                  />
                  {view.final && <span>Final</span>}
                </div>
                <div className="tp-terminal-keys" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              {view.paid && (
                <div className="tp-printed-receipt">
                  <Receipt
                    payment={payment}
                    threshold={data.health.confirmations}
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
