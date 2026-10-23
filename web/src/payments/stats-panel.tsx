import type { Stats } from './types';

/** Today's figures as tiles: settled count, average time to settle, duplicates and recoveries. */
export function StatsPanel({ stats }: { stats: Stats }) {
  return (
    <section aria-label="Today's statistics" className="tp-stats">
      {[
        [String(stats.settledCount), 'payments settled'],
        [
          stats.averageTimeToSettleMs === null
            ? '—'
            : `${Math.round(stats.averageTimeToSettleMs / 1000)}s`,
          'average time to settle',
        ],
        [String(stats.duplicatesSkipped), 'duplicates skipped'],
        [String(stats.failuresRecovered), 'failures recovered'],
      ].map(([value, label]) => (
        <div key={label}>
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </section>
  );
}
