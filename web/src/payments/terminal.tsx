import { useEffect, useState, type ReactNode } from 'react';

const labelSwapMs = 250;

/** Slides the old label out and the new one in; the first label appears without a transition. */
function StateLabel({ label }: { label: string }) {
  const [shown, setShown] = useState({
    current: label,
    previous: '',
    swaps: 0,
  });
  if (shown.current !== label)
    setShown({
      current: label,
      previous: shown.current,
      swaps: shown.swaps + 1,
    });
  useEffect(() => {
    if (!shown.swaps) return;
    const timer = setTimeout(() => {
      setShown((state) => ({ ...state, previous: '' }));
    }, labelSwapMs);
    return () => {
      clearTimeout(timer);
    };
  }, [shown.swaps]);
  return (
    <span className="tp-terminal-label" aria-live="polite">
      <strong
        key={shown.swaps}
        className={`tp-terminal-state ${shown.swaps ? 'tp-terminal-state-in' : ''}`}
      >
        {shown.current}
      </strong>
      {shown.previous && (
        <strong
          className="tp-terminal-state tp-terminal-state-out"
          aria-hidden="true"
        >
          {shown.previous}
        </strong>
      )}
    </span>
  );
}

/** The payment terminal: a screen headed by the rail and the current stage, above a keypad. */
export function Terminal({
  rail,
  label,
  final,
  children,
}: {
  rail: string;
  label: string;
  final: boolean;
  children: ReactNode;
}) {
  return (
    <div className="tp-terminal" role="group" aria-label="Payment terminal">
      <div className="tp-terminal-screen">
        <span className="tp-mono">{rail}</span>
        <StateLabel label={label} />
        {children}
        {final && <span>Final</span>}
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
  );
}
