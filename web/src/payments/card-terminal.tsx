import { receiptNote } from './notes';
import { Terminal } from './terminal';
import type { Payment } from './types';
import { cardBrandName, stageView } from './view';

/** The confirmation count does not apply to a card payment. */
const NO_THRESHOLD = 1;

export function CardTerminal({ payment }: { payment: Payment }) {
  const view = stageView(payment, NO_THRESHOLD);
  const card = payment.order?.customer;
  const failed = payment.noteKinds.includes('card_failed');
  return (
    <Terminal rail="TEST CARD" label={view.label} final={view.final}>
      <div className={`tp-tap ${view.paid ? 'tp-tap-done' : ''}`}>
        <div className="tp-tap-card" aria-label="Test card">
          <span className="tp-tap-chip" aria-hidden="true" />
          <span className="tp-mono tp-tap-number">
            {card?.cardLast4 ? `····${card.cardLast4}` : 'Test card'}
          </span>
          {card?.cardBrand && (
            <strong className="tp-tap-brand">
              {cardBrandName(card.cardBrand)}
            </strong>
          )}
        </div>
        <span className="tp-tap-waves" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      {failed && <p className="tp-note">{receiptNote(payment)}</p>}
    </Terminal>
  );
}
