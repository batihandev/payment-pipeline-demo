import { useState } from 'react';
import { Checkout } from './payments/checkout';
import { PaymentsWidget } from './payments/widget';
import { SettledChart } from './payments/chart';
import { Receipt } from './payments/receipt';
import { receiptNote } from './payments/notes';
import { usePayments } from './payments/use-payments';
import {
  confirmationsNeeded,
  isVisitorOrder,
  shortId,
  steps,
} from './payments/view';
import './panel.css';

export function PaymentsPanel({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { data, status } = usePayments(apiBaseUrl);
  const [visitorOrders, setVisitorOrders] = useState<ReadonlySet<string>>(
    new Set(),
  );
  return (
    <main className="tp tp-page">
      <header className="tp-page-header">
        <div className="tp-header-copy">
          <div className="tp-row">
            <span className={`tp-live ${status === 'live' ? 'tp-online' : ''}`}>
              {status === 'live'
                ? 'Live'
                : status === 'offline'
                  ? 'Demo offline'
                  : 'Connecting'}
            </span>
            <span className="tp-network">Test network</span>
          </div>
          <h1>Live payments</h1>
          <p>
            Fake purchases paid on a public test network, tracked from first
            sighting to settlement. Every payment is credited exactly once, even
            when providers fail or notices arrive twice.
          </p>
        </div>
        <a className="tp-counter-link" href="#checkout">
          Send a test purchase <span aria-hidden="true">↗</span>
        </a>
      </header>
      <div className="tp-shop-row">
        <div id="checkout">
          <Checkout
            apiBaseUrl={apiBaseUrl}
            repoUrl={import.meta.env.VITE_REPO_URL}
            onOrder={(id) =>
              setVisitorOrders((previous) => new Set([...previous, id]))
            }
          />
        </div>
        <div className="tp-widget-column">
          <div>
            <span className="tp-eyebrow tp-mono">A PAYMENT, AT A GLANCE</span>
            <h2>From sent to settled.</h2>
            <p className="tp-muted">
              Follow the latest receipt as the tracker sees it, confirms it and
              tells the shop.
            </p>
          </div>
          <PaymentsWidget apiBaseUrl={apiBaseUrl} />
        </div>
      </div>
      {status === 'offline' ? (
        <p className="tp-offline" role="status">
          Demo offline
        </p>
      ) : !data ? (
        <p role="status">Loading the payment trail…</p>
      ) : (
        <>
          {Object.entries(data.health?.balances ?? {})
            .filter(([, b]) => b.lowNative || b.lowUsdc)
            .map(([account]) => (
              <p key={account} className="tp-note" role="status">
                The demo’s {account} test account is running low. Purchases may
                pause until it is topped up.
              </p>
            ))}
          <section aria-label="Pipeline" className="tp-pipeline">
            {steps.map((step, index) => {
              const rows = data.payments.filter((p) => p.stage === step.stage);
              return (
                <div key={step.stage} className={`tp-lane tp-${step.color}`}>
                  <div className="tp-row tp-between">
                    <h2>
                      {index + 1} · {step.label}
                    </h2>
                    <strong>{rows.length}</strong>
                  </div>
                  <p>
                    {step.stage === 'confirming'
                      ? `Waiting for ${confirmationsNeeded(data.health)} blocks on top`
                      : step.hint}
                  </p>
                  <div className="tp-row">
                    {rows.slice(0, 4).map((p) => (
                      <a
                        className="tp-stage"
                        href={`#payment-${p.id}`}
                        key={p.id}
                      >
                        #{shortId(p.orderId ?? p.id)}
                      </a>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
          <p className="tp-mono tp-muted">
            Pipeline counts cover the {data.payments.length} most recent
            payments.
            {data.payments.some((p) => p.stage === 'sent') &&
              ` ${data.payments.filter((p) => p.stage === 'sent').length} sent; awaiting the tracker.`}
          </p>
          <SettledChart days={data.daily} />
          <div className="tp-detail-grid">
            <section aria-labelledby="receipts-title" className="tp-feed">
              <h2 id="receipts-title">Receipts</h2>
              {data.payments.length === 0 && <p>No payments yet.</p>}
              {data.payments.map((payment) => (
                <div id={`payment-${payment.id}`} key={payment.id}>
                  <Receipt
                    payment={payment}
                    threshold={confirmationsNeeded(data.health)}
                    highlighted={isVisitorOrder(payment, visitorOrders)}
                    note={receiptNote(payment, data.incidents)}
                  />
                </div>
              ))}
            </section>
            <aside className="tp-sidebar">
              <h2 className="tp-stats-title">Today · UTC</h2>
              <section aria-label="Today's statistics" className="tp-stats">
                {[
                  [String(data.stats.settledCount), 'payments settled'],
                  [
                    data.stats.averageTimeToSettleMs === null
                      ? '—'
                      : `${Math.round(data.stats.averageTimeToSettleMs / 1000)}s`,
                    'average time to settle',
                  ],
                  [String(data.stats.duplicatesSkipped), 'duplicates skipped'],
                  [String(data.stats.failuresRecovered), 'failures recovered'],
                ].map(([value, label]) => (
                  <div key={label}>
                    <strong>{value}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </section>
              {data.health && (
                <section className="tp-health" aria-label="Tracker health">
                  <h2>Behind the counter</h2>
                  <dl>
                    {[
                      ['Head', data.health.head ?? 'Unknown'],
                      [
                        'Scanned through',
                        data.health.cursor ?? 'Not initialized',
                      ],
                      ['Blocks behind', data.health.lag ?? 'Unknown'],
                      ['Open scan gaps', data.health.openGaps],
                      [
                        'Queued work',
                        data.health.queueDepth
                          ? Object.values(data.health.queueDepth).reduce(
                              (a, b) => a + b,
                              0,
                            )
                          : 'Unknown',
                      ],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {Object.entries(data.health.cooldowns ?? {})
                    .filter(([, ms]) => ms > 0)
                    .map(([name, ms]) => (
                      <p className="tp-note" key={name}>
                        {name}: cooling down for {Math.ceil(ms / 1000)}s
                      </p>
                    ))}
                </section>
              )}
            </aside>
          </div>
        </>
      )}
      <footer className="tp-page-footer tp-mono">
        Test purchases. Real confirmations. One credit per payment.
      </footer>
    </main>
  );
}
