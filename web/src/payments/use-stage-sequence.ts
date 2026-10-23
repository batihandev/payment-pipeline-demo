import { useEffect, useRef, useState } from 'react';
import type { Payment } from './types';

export const stageHoldMs = 600;
const order = [
  'sent',
  'received',
  'confirming',
  'processing',
  'settled',
  'notified',
] as const satisfies readonly Payment['stage'][];
export type StageFrame = {
  stage: (typeof order)[number];
  confirmations: number;
  final: boolean;
};
const settledAt = order.indexOf('settled');

/**
 * The frames to show after `previous` to reach `next`, one for each stage the payment passed
 * through. A stage before settlement carries the last count seen before it; settlement carries
 * the new one, because it needs those confirmations.
 */
export function framesBetween(
  previous: StageFrame | null,
  next: StageFrame,
): StageFrame[] {
  const from = previous ? order.indexOf(previous.stage) : -1;
  const to = order.indexOf(next.stage);
  const frames: StageFrame[] = order.slice(from + 1, to).map((stage, i) => ({
    stage,
    confirmations:
      from + 1 + i < settledAt
        ? (previous?.confirmations ?? 0)
        : next.confirmations,
    final: false,
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
    Pick<Payment, 'id' | 'stage' | 'confirmations' | 'final'> | undefined,
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
  useEffect(() => {
    if (
      stage === undefined ||
      confirmations === undefined ||
      final === undefined
    )
      return;
    sequence.current?.push({ stage, confirmations, final });
  }, [id, stage, confirmations, final]);
  return shown && shown.id === id ? shown.frame : null;
}
