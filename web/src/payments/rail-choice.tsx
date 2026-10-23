import type { Rail } from './client';

const rails: { rail: Rail; label: string }[] = [
  { rail: 'chain', label: 'Pay on the test network' },
  { rail: 'card', label: 'Pay with a test card' },
];

export function RailChoice({
  cardAvailable,
  disabled,
  chosen,
  busyLabel,
  onChoose,
}: {
  cardAvailable: boolean;
  disabled: boolean;
  chosen?: Rail;
  busyLabel?: string;
  onChoose: (rail: Rail) => void;
}) {
  return (
    <div className="tp-rails" role="group" aria-label="Payment method">
      {rails
        .filter(({ rail }) => rail === 'chain' || cardAvailable)
        .map(({ rail, label }) => (
          <button
            key={rail}
            type="button"
            className={`tp-rail-button tp-rail-${rail}`}
            disabled={disabled}
            onClick={() => onChoose(rail)}
          >
            {rail === chosen && busyLabel ? busyLabel : label}
          </button>
        ))}
    </div>
  );
}
