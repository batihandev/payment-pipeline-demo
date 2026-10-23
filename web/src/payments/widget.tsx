import { usePayments } from './use-payments';
import { Receipt, StepStrip } from './receipt';
import { confirmationsNeeded } from './view';
import './styles.css';

export function PaymentsWidget({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { data, status } = usePayments(apiBaseUrl);
  if (!data) return null;
  const payment = data.payments[0];
  return (
    <section className="tp tp-widget" aria-label="Live payments widget">
      <header className="tp-row tp-between">
        <span
          className={`tp-live ${status === 'live' ? 'tp-live-connected' : ''}`}
        >
          Live payments
        </span>
        <span className="tp-network">Test network</span>
      </header>
      {payment ? (
        <>
          <Receipt
            key={payment.id}
            payment={payment}
            threshold={confirmationsNeeded(data.health)}
            compact
          />
          <StepStrip payment={payment} />
        </>
      ) : (
        <p>No payments yet.</p>
      )}
      <footer className="tp-widget-counts tp-mono">
        <span>{data.stats.settledCount} settled</span>
        <span>{data.stats.duplicatesSkipped} duplicates skipped</span>
        <span>{data.stats.failuresRecovered} recovered</span>
        <span>today · UTC</span>
      </footer>
    </section>
  );
}
