import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  framesBetween,
  startStageSequence,
  stageHoldMs,
  type StageFrame,
} from './use-stage-sequence';

const frame = (
  stage: StageFrame['stage'],
  confirmations = 0,
  final = false,
  provider: StageFrame['provider'] = 'chain',
): StageFrame => ({ stage, confirmations, final, provider });
const stages = (frames: StageFrame[]) => frames.map((f) => f.stage);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('framesBetween', () => {
  it('starts a first sighting from the first stage a payment passes through', () => {
    expect(stages(framesBetween(null, frame('confirming', 2)))).toEqual([
      'sent',
      'received',
      'confirming',
    ]);
  });
  it('lists every stage passed between two sightings, ending on the new one', () => {
    expect(
      stages(framesBetween(frame('confirming', 3), frame('notified', 10))),
    ).toEqual(['settled', 'notified']);
  });
  it('never shows a chain payment as processing', () => {
    expect(stages(framesBetween(null, frame('notified', 10)))).not.toContain(
      'processing',
    );
  });
  it('steps a card payment through processing, which it has no confirmations for', () => {
    expect(
      stages(framesBetween(null, frame('notified', 0, false, 'stripe'))),
    ).toEqual(['sent', 'processing', 'settled', 'notified']);
  });
  it('goes straight to failed without passing through settlement', () => {
    expect(
      stages(
        framesBetween(
          frame('processing', 0, false, 'stripe'),
          frame('failed', 0, true, 'stripe'),
        ),
      ),
    ).toEqual(['failed']);
    expect(
      stages(framesBetween(null, frame('failed', 0, true, 'stripe'))),
    ).toEqual(['failed']);
  });
  it('gives a same-stage update as the only frame', () => {
    expect(
      framesBetween(frame('confirming', 3), frame('confirming', 4)),
    ).toEqual([frame('confirming', 4)]);
  });
  it('uses only counts the payment has had for the stages it passed', () => {
    const frames = framesBetween(frame('received', 0), frame('notified', 10));
    expect(frames.map((f) => [f.stage, f.confirmations])).toEqual([
      ['confirming', 0],
      ['settled', 10],
      ['notified', 10],
    ]);
  });
});

describe('stage sequence', () => {
  const start = () => {
    const shown: StageFrame[] = [];
    const sequence = startStageSequence((f) => shown.push(f));
    return { shown, sequence };
  };

  it('shows the first sighting at once', () => {
    const { shown, sequence } = start();
    sequence.push(frame('sent'));
    expect(stages(shown)).toEqual(['sent']);
  });

  it('steps through the stages a payment skipped, holding each', () => {
    const { shown, sequence } = start();
    sequence.push(frame('confirming', 0));
    expect(stages(shown)).toEqual(['sent']);
    vi.advanceTimersByTime(stageHoldMs - 1);
    expect(stages(shown)).toEqual(['sent']);
    vi.advanceTimersByTime(1);
    expect(stages(shown)).toEqual(['sent', 'received']);
    vi.advanceTimersByTime(stageHoldMs);
    expect(stages(shown)).toEqual(['sent', 'received', 'confirming']);
    sequence.push(frame('notified', 10, true));
    expect(stages(shown).at(-1)).toBe('confirming');
    vi.advanceTimersByTime(stageHoldMs);
    expect(stages(shown).slice(3)).toEqual(['settled']);
    vi.advanceTimersByTime(stageHoldMs);
    expect(stages(shown).slice(3)).toEqual(['settled', 'notified']);
    expect(shown.at(-1)).toEqual(frame('notified', 10, true));
  });

  it('applies a count change within the same stage without waiting', () => {
    const { shown, sequence } = start();
    sequence.push(frame('sent'));
    vi.advanceTimersByTime(stageHoldMs);
    sequence.push(frame('received', 0));
    vi.advanceTimersByTime(stageHoldMs);
    sequence.push(frame('confirming', 1));
    vi.advanceTimersByTime(stageHoldMs);
    sequence.push(frame('confirming', 2));
    expect(shown.at(-1)).toEqual(frame('confirming', 2));
  });

  it('keeps only the latest real count for a stage still waiting its turn', () => {
    const { shown, sequence } = start();
    sequence.push(frame('sent'));
    sequence.push(frame('received', 0));
    sequence.push(frame('received', 0, false));
    sequence.push(frame('confirming', 1));
    sequence.push(frame('confirming', 3));
    vi.advanceTimersByTime(stageHoldMs * 3);
    expect(shown.map((f) => [f.stage, f.confirmations])).toEqual([
      ['sent', 0],
      ['received', 0],
      ['confirming', 3],
    ]);
  });

  it('shows nothing after it is stopped', () => {
    const { shown, sequence } = start();
    sequence.push(frame('confirming', 0));
    sequence.stop();
    vi.advanceTimersByTime(stageHoldMs * 5);
    expect(stages(shown)).toEqual(['sent']);
  });
});
