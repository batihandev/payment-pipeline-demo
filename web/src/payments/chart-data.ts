import type { DailyStat } from './types';

export type WeeklyStat = {
  weekStart: string;
  settled: number;
  scheduled: number;
  visitor: number;
};
const dayMs = 86_400_000;
function weekStart(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  const sinceMonday = (new Date(time).getUTCDay() + 6) % 7;
  return new Date(time - sinceMonday * dayMs).toISOString().slice(0, 10);
}
export function weekly(days: readonly DailyStat[]): WeeklyStat[] {
  const weeks = new Map<string, WeeklyStat>();
  for (const d of days) {
    const key = weekStart(d.day);
    const week = weeks.get(key) ?? {
      weekStart: key,
      settled: 0,
      scheduled: 0,
      visitor: 0,
    };
    week.settled += d.settled;
    week.scheduled += d.scheduled;
    week.visitor += d.visitor;
    weeks.set(key, week);
  }
  return [...weeks.values()].sort((a, b) =>
    a.weekStart.localeCompare(b.weekStart),
  );
}

export type ChartBar = {
  key: string;
  label: string;
  scheduled: number;
  visitor: number;
  averageMs: number | null;
};
export function chartBars(
  days: readonly DailyStat[],
  mode: 'daily' | 'weekly',
): ChartBar[] {
  if (mode === 'daily')
    return days.map((d) => ({
      key: d.day,
      label: d.day,
      scheduled: d.scheduled,
      visitor: d.visitor,
      averageMs: d.averageTimeToSettleMs,
    }));
  return weekly(days).map((w) => {
    const inWeek = days.filter(
      (d) =>
        weekStart(d.day) === w.weekStart && d.averageTimeToSettleMs !== null,
    );
    const settled = inWeek.reduce((sum, d) => sum + d.settled, 0);
    return {
      key: w.weekStart,
      label: `Week of ${w.weekStart}`,
      scheduled: w.scheduled,
      visitor: w.visitor,
      averageMs: settled
        ? inWeek.reduce(
            (sum, d) => sum + (d.averageTimeToSettleMs ?? 0) * d.settled,
            0,
          ) / settled
        : null,
    };
  });
}
