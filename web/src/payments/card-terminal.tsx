import { Terminal } from './terminal';
import type { Payment } from './types';
import { cardBrandName, stageView } from './view';

export function CardTerminal({ payment }: { payment: Payment }) {
  const view = stageView(payment);
  const card = payment.order?.customer;
  return (
    <Terminal rail="TEST CARD" label={view.label} final={view.final}>
      <div className={`tp-tap ${view.paid ? 'tp-tap-done' : ''}`}>
        <div className="tp-tap-card" aria-label="Test card">
          <span className="tp-tap-top">
            <span className="tp-tap-chip" aria-hidden="true" />
            {card?.cardBrand && (
              <strong className="tp-tap-brand">
                {cardBrandName(card.cardBrand)}
              </strong>
            )}
          </span>
          <span className="tp-mono tp-tap-number">
            {card?.cardLast4 ? `····${card.cardLast4}` : 'Test card'}
          </span>
        </div>
        <span className="tp-tap-waves" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </Terminal>
  );
}
