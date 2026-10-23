import { useState } from 'react';
import { chartBars } from './chart-data';
import type { DailyStat } from './types';
import './chart.css';

const width = 360;
const height = 240;
const pad = { top: 12, right: 40, bottom: 28, left: 34 };
const plotWidth = width - pad.left - pad.right;
const plotHeight = height - pad.top - pad.bottom;

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}
function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
export function SettledChart({ days }: { days: DailyStat[] }) {
  const [mode, setMode] = useState<'daily' | 'weekly'>('daily');
  const bars = chartBars(days, mode);
  const countMax = niceMax(
    Math.max(0, ...bars.map((b) => b.scheduled + b.visitor)),
  );
  const timeMax = niceMax(
    Math.max(0, ...bars.map((b) => (b.averageMs ?? 0) / 1000)),
  );
  const slot = plotWidth / Math.max(bars.length, 1);
  const barWidth = Math.max(2, slot * 0.7);
  const x = (i: number) => pad.left + slot * i + slot / 2;
  const y = (count: number) => pad.top + plotHeight * (1 - count / countMax);
  const yTime = (s: number) => pad.top + plotHeight * (1 - s / timeMax);
  const segments: string[][] = [];
  bars.forEach((b, i) => {
    if (b.averageMs === null) {
      segments.push([]);
      return;
    }
    const last = segments[segments.length - 1];
    const point = `${x(i).toFixed(1)},${yTime(b.averageMs / 1000).toFixed(1)}`;
    if (last) last.push(point);
    else segments.push([point]);
  });
  const labelAt = [
    ...new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1]),
  ];
  return (
    <section aria-labelledby="chart-title" className="tp-chart">
      <div className="tp-row tp-between">
        <div>
          <h2 id="chart-title">Settled payments</h2>
          <p className="tp-muted">
            {mode === 'daily' ? 'Per day' : 'Per week'} · UTC · last{' '}
            {days.length} days
          </p>
        </div>
        <div className="tp-toggle" role="group" aria-label="Chart period">
          {(['daily', 'weekly'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value === 'daily' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Settled payments per ${mode === 'daily' ? 'day' : 'week'}, scheduled and visitor purchases stacked, with the average time to settle as a line`}
      >
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              className="tp-chart-grid"
              x1={pad.left}
              x2={width - pad.right}
              y1={y(countMax * fraction)}
              y2={y(countMax * fraction)}
            />
            <text
              className="tp-chart-text"
              x={pad.left - 4}
              y={y(countMax * fraction) + 3}
              textAnchor="end"
            >
              {Math.round(countMax * fraction)}
            </text>
            <text
              className="tp-chart-text tp-chart-time"
              x={width - pad.right + 4}
              y={y(countMax * fraction) + 3}
            >
              {Math.round(timeMax * fraction)}s
            </text>
          </g>
        ))}
        {bars.map((b, i) => (
          <g key={b.key}>
            <title>
              {`${b.label}: ${b.scheduled} scheduled, ${b.visitor} visitor, average ${b.averageMs === null ? 'none' : seconds(b.averageMs)}`}
            </title>
            <rect
              className="tp-chart-scheduled"
              x={x(i) - barWidth / 2}
              y={y(b.scheduled)}
              width={barWidth}
              height={y(0) - y(b.scheduled)}
            />
            <rect
              className="tp-chart-visitor"
              x={x(i) - barWidth / 2}
              y={y(b.scheduled + b.visitor)}
              width={barWidth}
              height={y(b.scheduled) - y(b.scheduled + b.visitor)}
            />
          </g>
        ))}
        {segments.map((points, i) =>
          points.length > 1 ? (
            <polyline
              key={i}
              className="tp-chart-line"
              points={points.join(' ')}
            />
          ) : points.length === 1 ? (
            <circle
              key={i}
              className="tp-chart-dot"
              cx={points[0]?.split(',')[0]}
              cy={points[0]?.split(',')[1]}
              r="2"
            />
          ) : null,
        )}
        {labelAt.map((index, n) => {
          const bar = bars[index];
          return bar ? (
            <text
              key={n}
              className="tp-chart-text"
              x={x(index)}
              y={height - 8}
              textAnchor={
                index === 0
                  ? 'start'
                  : index === bars.length - 1
                    ? 'end'
                    : 'middle'
              }
            >
              {bar.key.slice(5)}
            </text>
          ) : null;
        })}
      </svg>
      <ul className="tp-chart-legend tp-mono">
        <li className="tp-chart-key-scheduled">Scheduled</li>
        <li className="tp-chart-key-visitor">Visitor</li>
        <li className="tp-chart-key-line">
          Average time to settle (right axis)
        </li>
      </ul>
    </section>
  );
}
