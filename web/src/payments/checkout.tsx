import { useEffect, useRef, useState } from 'react';
import { CardTerminal } from './card-terminal';
import { ChainTerminal } from './chain-terminal';
import { checkoutDeadline, checkoutState } from './checkout-state';
import { RailChoice } from './rail-choice';
import { Receipt } from './receipt';
import { usePayments } from './use-payments';
import { usePurchase } from './use-purchase';
import { useOrderStatus } from './use-order-status';
import { useStageSequence } from './use-stage-sequence';
import { cardRail, confirmationsNeeded, money, stageView } from './view';
import './styles.css';
import './checkout.css';

/** The current time, read again just after `deadline` so a render can tell it has passed. */
function useTimeAfter(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(
      () => {
        setNow(Math.max(Date.now(), deadline + 1));
      },
      Math.max(0, deadline + 1 - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [deadline]);
  return now;
}

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
  const drawerHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (opened) drawerHeading.current?.focus();
  }, [opened]);
  const {
    sending,
    orderId,
    rail,
    message,
    accepted,
    ordered,
    expiresAt,
    purchase,
  } = usePurchase(apiBaseUrl, onOrder);
  const latest = data?.payments.find((p) => p.orderId === orderId);
  const frame = useStageSequence(latest);
  const payment = latest && frame ? { ...latest, ...frame } : undefined;
  const threshold = confirmationsNeeded(data?.health ?? null);
  const view = payment ? stageView(payment) : null;
  const item = ordered?.item ?? latest?.order?.item;
  const price = ordered?.price ?? latest?.order?.price ?? latest?.amount;
  const paid = view?.paid ?? false;
  const order = useOrderStatus(apiBaseUrl, orderId ?? null, accepted, paid);
  const now = useTimeAfter(checkoutDeadline({ payment, expiresAt }));
  const checkout = checkoutState({
    status,
    orderId,
    expiresAt,
    payment,
    paid,
    order,
    sending,
    message,
    now,
  });

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
          onClick={() => {
            setOpened(true);
          }}
        >
          Open the counter
        </button>
      ) : (
        <div className="tp-drawer">
          <h3 ref={drawerHeading} tabIndex={-1}>
            How would you like to pay?
          </h3>
          <p className="tp-muted">
            The shop chooses an item when your order is accepted.
          </p>
          <RailChoice
            card={cardRail(data?.health ?? null)}
            disabled={checkout.busy || status !== 'live'}
            chosen={rail}
            busyLabel={checkout.busyLabel}
            onChoose={(chosen) => {
              void purchase(chosen);
            }}
          />
          <div role="status" className="tp-purchase-status">
            {checkout.statusText}
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
