import { describe, expect, it } from 'vitest';
import { averageRuns, chartBars, weekly } from './chart-data';
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
describe('chartBars', () => {
  it('shows the last 14 days per day and every retained week per week', () => {
    const days = Array.from({ length: 30 }, (_, i) =>
      day(new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10), 1, 0),
    );
    const daily = chartBars(days, 'daily');
    expect(daily).toHaveLength(14);
    expect(daily[0]?.key).toBe('2026-10-10');
    expect(daily.at(-1)?.key).toBe('2026-10-23');
    expect(chartBars(days, 'weekly').map((w) => w.key)).toEqual([
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
  });
});
describe('averageRuns', () => {
  it('joins only consecutive days', () => {
    const bars = chartBars(
      [
        day('2026-10-10', 1, 0, 5000),
        day('2026-10-11', 1, 0, 7000),
        day('2026-10-12', 0, 0),
        day('2026-10-13', 1, 0, 6000),
        day('2026-10-15', 2, 0, 9000),
        day('2026-10-16', 1, 1, 8000),
      ],
      'daily',
    );
    expect(averageRuns(bars, 'daily')).toEqual([[0, 1], [3], [4, 5]]);
  });
  it('joins consecutive weeks', () => {
    const bars = chartBars(
      [
        day('2026-09-28', 1, 0, 5000),
        day('2026-10-05', 1, 0, 6000),
        day('2026-10-19', 1, 0, 7000),
      ],
      'weekly',
    );
    expect(averageRuns(bars, 'weekly')).toEqual([[0, 1], [2]]);
  });
});
