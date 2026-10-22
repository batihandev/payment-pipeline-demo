import { describe, expect, it } from 'vitest';
import { weekly } from './chart-data';
import type { DailyStat } from './types';

const day = (
  date: string,
  scheduled: number,
  visitor: number,
  averageTimeToSettleMs: number | null = null,
): DailyStat => ({
  day: date,
  settled: scheduled + visitor,
  scheduled,
  visitor,
  averageTimeToSettleMs,
});
describe('weekly', () => {
  it('groups days into Monday-start UTC weeks with summed counts', () => {
    const days = Array.from({ length: 14 }, (_, i) =>
      day(`2026-10-${String(12 + i).padStart(2, '0')}`, 2, 1),
    );
    expect(weekly(days)).toEqual([
      { weekStart: '2026-10-12', settled: 21, scheduled: 14, visitor: 7 },
      { weekStart: '2026-10-19', settled: 21, scheduled: 14, visitor: 7 },
    ]);
  });
  it('starts a Sunday in the week of the Monday before it', () => {
    expect(
      weekly([day('2026-10-17', 1, 0), day('2026-10-18', 3, 2)]).map(
        (w) => w.weekStart,
      ),
    ).toEqual(['2026-10-12']);
    expect(weekly([day('2026-10-19', 1, 0)])[0]?.weekStart).toBe('2026-10-19');
  });
  it('returns nothing for no days', () => {
    expect(weekly([])).toEqual([]);
  });
});
