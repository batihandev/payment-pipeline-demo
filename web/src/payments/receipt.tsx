import type { Payment } from './types';
import {
  money,
  railBadge,
  shortId,
  failedStep,
  paymentFailed,
  stageView,
  stepsFor,
  utcTime,
} from './view';
import './styles.css';

export function ConfirmationBar({
  payment,
  threshold,
}: {
  payment: Payment;
  threshold: number;
}) {
  const view = stageView(payment, threshold);
  return (
    <div className={`tp-confirmations tp-${view.color}`}>
      <div
        className="tp-bar"
        role="progressbar"
        aria-label="Payment confirmations"
        aria-valuemin={0}
        aria-valuemax={threshold}
        aria-valuenow={Math.min(payment.confirmations, threshold)}
        aria-valuetext={view.confirmationLabel}
      >
        <span style={{ width: `${view.progress * 100}%` }} />
      </div>
      <span className="tp-mono tp-muted">{view.confirmationLabel}</span>
    </div>
  );
}
export function StepStrip({ payment }: { payment: Payment }) {
  const failed = paymentFailed(payment);
  // A failed payment ends on Failed in place of the stages it never reached.
  const steps = failed
    ? [
        ...stepsFor(payment.provider).filter(
          (s) => s.stage !== 'settled' && s.stage !== 'notified',
        ),
        failedStep,
      ]
    : stepsFor(payment.provider);
  const step = failed
    ? steps.length - 1
    : steps.findIndex((s) => s.stage === payment.stage);
  return (
    <ol className="tp-strip" aria-label="Payment stages">
      {steps.map((s, i) => (
        <li
          key={s.stage}
          className={
            failed
              ? i === step
                ? 'tp-reached tp-failed'
                : ''
              : i <= step
                ? 'tp-reached'
                : ''
          }
          aria-current={i === step ? 'step' : undefined}
        >
          {s.label === 'Shop notified' ? 'Notified' : s.label}
        </li>
      ))}
    </ol>
  );
}
export function Receipt({
  payment,
  threshold,
  highlighted = false,
  compact = false,
  note = null,
}: {
  payment: Payment;
  threshold: number;
  highlighted?: boolean;
  compact?: boolean;
  note?: string | null;
}) {
  const view = stageView(payment);
  const card = payment.provider === 'stripe';
  return (
    <article
      className={`tp-receipt ${highlighted ? 'tp-yours' : ''} ${compact ? 'tp-compact' : ''}`}
    >
      {highlighted && <span className="tp-own-label">Your test purchase</span>}
      <div className="tp-receipt-heading">
        <div>
          <h3>
            {payment.order?.item ??
              (payment.donation
                ? payment.donorName
                  ? `Donation from ${payment.donorName}`
                  : 'Donation'
                : payment.orderId
                  ? 'Order details pending'
                  : 'Unmatched payment')}
          </h3>
          <p className="tp-mono tp-muted">
            {payment.orderId
              ? `Order #${shortId(payment.orderId)}`
              : `Payment #${shortId(payment.id)}`}
            {!compact && (payment.sentAt ?? payment.receivedAt)
              ? ` · ${utcTime((payment.sentAt ?? payment.receivedAt) as string)} UTC`
              : ''}
          </p>
        </div>
        <strong className="tp-price">
          {money(payment.order?.price ?? payment.amount)}
        </strong>
      </div>
      <div className="tp-row">
        <span className={`tp-stage tp-${view.color}`}>{view.label}</span>
        {view.final && <span className="tp-stage tp-green">Final</span>}
        <span className="tp-network tp-rail">{railBadge(payment)}</span>
      </div>
      {!card && <ConfirmationBar payment={payment} threshold={threshold} />}
      {note && <p className="tp-note">{note}</p>}
      <div className="tp-receipt-footer tp-mono tp-muted">
        {card ? (
          payment.receiptUrl?.startsWith('https://') && (
            <a href={payment.receiptUrl} target="_blank" rel="noreferrer">
              View Stripe receipt
            </a>
          )
        ) : (
          <>
            <span>
              {payment.blockNumber
                ? `block ${payment.blockNumber}`
                : 'Awaiting a block'}
            </span>
            {payment.explorerUrl && (
              <a href={payment.explorerUrl} target="_blank" rel="noreferrer">
                View on explorer
              </a>
            )}
          </>
        )}
      </div>
      {view.paid && <span className="tp-paid">PAID</span>}
    </article>
  );
}
