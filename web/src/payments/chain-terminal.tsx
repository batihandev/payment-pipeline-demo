import { ConfirmationBar } from './receipt';
import { Terminal } from './terminal';
import type { Payment } from './types';
import { stageView } from './view';

export function ChainTerminal({
  payment,
  threshold,
}: {
  payment: Payment;
  threshold: number;
}) {
  const view = stageView(payment, threshold);
  return (
    <Terminal rail="TEST NETWORK" label={view.label} final={view.final}>
      <div
        className="tp-block-stack"
        aria-hidden="true"
        style={{
          gridTemplateColumns: `repeat(${threshold}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: threshold }, (_, index) => (
          <span
            key={index}
            className={
              index < payment.confirmations ? 'tp-block-confirmed' : ''
            }
          />
        ))}
      </div>
      <ConfirmationBar payment={payment} threshold={threshold} />
    </Terminal>
  );
}
