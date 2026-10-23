import type { Health } from './types';

/** The tracker's state behind the counter: chain head, scan progress, gaps, queued work, cooldowns. */
export function HealthPanel({ health }: { health: Health }) {
  return (
    <section className="tp-health" aria-label="Tracker health">
      <h2>Behind the counter</h2>
      <dl>
        {[
          ['Head', health.head ?? 'Unknown'],
          ['Scanned through', health.cursor ?? 'Not initialized'],
          ['Blocks behind', health.lag ?? 'Unknown'],
          ['Open scan gaps', health.openGaps],
          [
            'Queued work',
            health.queueDepth
              ? Object.values(health.queueDepth).reduce((a, b) => a + b, 0)
              : 'Unknown',
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {Object.entries(health.cooldowns ?? {})
        .filter(([, ms]) => ms > 0)
        .map(([name, ms]) => (
          <p className="tp-note" key={name}>
            {name}: cooling down for {Math.ceil(ms / 1000)}s
          </p>
        ))}
    </section>
  );
}
