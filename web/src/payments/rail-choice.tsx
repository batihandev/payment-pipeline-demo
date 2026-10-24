import type { Rail } from './client';
import type { CardRail } from './view';

const rails: { rail: Rail; label: string }[] = [
  { rail: 'chain', label: 'Pay on the test network' },
  { rail: 'card', label: 'Pay with a test card' },
];

export function RailChoice({
  card,
  disabled,
  chosen,
  busyLabel,
  onChoose,
}: {
  card: CardRail;
  disabled: boolean;
  chosen?: Rail;
  busyLabel?: string;
  onChoose: (rail: Rail) => void;
}) {
  return (
    <div className="tp-rails" role="group" aria-label="Payment method">
      {rails
        .filter(({ rail }) => rail === 'chain' || card !== 'unavailable')
        .map(({ rail, label }) => {
          // aria-disabled rather than disabled, so the button just pressed keeps focus.
          const unavailable =
            disabled || (rail === 'card' && card !== 'available');
          return (
            <button
              key={rail}
              type="button"
              className={`tp-rail-button tp-rail-${rail}`}
              aria-disabled={unavailable}
              onClick={() => {
                if (!unavailable) onChoose(rail);
              }}
            >
              {rail === chosen && busyLabel ? busyLabel : label}
            </button>
          );
        })}
    </div>
  );
}
