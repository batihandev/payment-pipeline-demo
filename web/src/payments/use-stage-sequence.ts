import { useEffect, useRef, useState } from 'react';
import type { Payment } from './types';

export const stageHoldMs = 600;
const orders = {
  chain: ['sent', 'received', 'confirming', 'settled', 'notified'],
  stripe: ['sent', 'processing', 'settled', 'notified'],
} as const satisfies Record<Payment['provider'], readonly Payment['stage'][]>;
/** How far along a payment is; a stage outside its provider's order (failed) is final, so it ranks last. */
export function stageRank(
  payment: Pick<Payment, 'provider' | 'stage'>,
): number {
  const at = (orders[payment.provider] as readonly Payment['stage'][]).indexOf(
    payment.stage,
  );
  return at === -1 ? Infinity : at;
}
export type StageFrame = {
  stage: Payment['stage'];
  confirmations: number;
  final: boolean;
  provider: Payment['provider'];
};

/**
 * The frames to show after `previous` to reach `next`, one for each stage the payment passed
 * through. A stage before settlement carries the last count seen before it; settlement carries
 * the new one, because it needs those confirmations.
 */
export function framesBetween(
  previous: StageFrame | null,
  next: StageFrame,
): StageFrame[] {
  const order: readonly Payment['stage'][] = orders[next.provider];
  const settledAt = order.indexOf('settled');
  const from = previous ? order.indexOf(previous.stage) : -1;
  const to = order.indexOf(next.stage);
  // A failed payment leaves the stage order; it is shown as it is, never through settlement.
  if (to === -1) return [next];
  const frames: StageFrame[] = order.slice(from + 1, to).map((stage, i) => ({
    stage,
    confirmations:
      from + 1 + i < settledAt
        ? (previous?.confirmations ?? 0)
        : next.confirmations,
    final: false,
    provider: next.provider,
  }));
  frames.push(next);
  return frames;
}

export function startStageSequence(
  onFrame: (frame: StageFrame) => void,
  hold = stageHoldMs,
) {
  let latest: StageFrame | null = null;
  let shown: StageFrame | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: StageFrame[] = [];
  function show(frame: StageFrame) {
    shown = frame;
    onFrame(frame);
  }
  function pump() {
    const frame = queue.shift();
    if (!frame) return;
    show(frame);
    timer = setTimeout(() => {
      timer = undefined;
      pump();
    }, hold);
  }
  return {
    push(next: StageFrame) {
      const frames = framesBetween(latest, next);
      latest = next;
      if (frames.length === 1 && !queue.length && shown?.stage === next.stage)
        return show(next);
      if (frames.length === 1 && queue.at(-1)?.stage === next.stage)
        queue[queue.length - 1] = next;
      else queue.push(...frames);
      if (!timer) pump();
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
      queue.length = 0;
    },
  };
}

/** The payment as the visitor has watched it: every stage it passed through, in order. */
export function useStageSequence(
  payment:
    | Pick<Payment, 'id' | 'stage' | 'confirmations' | 'final' | 'provider'>
    | undefined,
): StageFrame | null {
  const [shown, setShown] = useState<{ id: string; frame: StageFrame }>();
  const sequence = useRef<ReturnType<typeof startStageSequence>>(undefined);
  const id = payment?.id;
  useEffect(() => {
    if (!id) return;
    const started = startStageSequence((frame) => setShown({ id, frame }));
    sequence.current = started;
    return () => {
      started.stop();
      sequence.current = undefined;
    };
  }, [id]);
  const stage = payment?.stage;
  const confirmations = payment?.confirmations;
  const final = payment?.final;
  const provider = payment?.provider;
  useEffect(() => {
    if (
      stage === undefined ||
      confirmations === undefined ||
      final === undefined ||
      provider === undefined
    )
      return;
    sequence.current?.push({ stage, confirmations, final, provider });
  }, [id, stage, confirmations, final, provider]);
  return shown && shown.id === id ? shown.frame : null;
}
