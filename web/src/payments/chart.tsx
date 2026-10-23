import { useLayoutEffect, useRef, useState } from 'react';
import { averageRuns, chartBars, DAILY_DAYS } from './chart-data';
import type { DailyStat } from './types';
import './chart.css';

/** The plot is drawn at the card's own width, so text and bars keep their size at any width. */
const DEFAULT_WIDTH = 640;
const pad = { top: 12, right: 40, bottom: 28, left: 32 };
const LABEL_SPACING = 64;

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}
function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
/** Evenly spread label positions, always including the first and the last bar. */
function labelIndexes(count: number, room: number): number[] {
  if (count === 0) return [];
  const labels = Math.max(2, Math.min(count, Math.floor(room / LABEL_SPACING)));
  return [
    ...new Set(
      Array.from({ length: labels }, (_, i) =>
        Math.round((i * (count - 1)) / Math.max(labels - 1, 1)),
      ),
    ),
  ];
}
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      setWidth(Math.round(element.clientWidth) || DEFAULT_WIDTH);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width] as const;
}
export function SettledChart({ days }: { days: DailyStat[] }) {
  const [mode, setMode] = useState<'daily' | 'weekly'>('daily');
  const [plotRef, width] = useWidth<HTMLDivElement>();
  const height = width < 480 ? 220 : 260;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const bars = chartBars(days, mode);
  const countMax = niceMax(
    Math.max(0, ...bars.map((b) => b.scheduled + b.visitor)),
  );
  const timeMax = niceMax(
    Math.max(0, ...bars.map((b) => (b.averageMs ?? 0) / 1000)),
  );
  const slot = plotWidth / Math.max(bars.length, 1);
  const barWidth = Math.min(48, Math.max(2, slot * 0.6));
  const x = (i: number) => pad.left + slot * i + slot / 2;
  const y = (count: number) => pad.top + plotHeight * (1 - count / countMax);
  const yTime = (ms: number) =>
    pad.top + plotHeight * (1 - ms / 1000 / timeMax);
  const point = (i: number) => {
    const ms = bars[i]?.averageMs ?? 0;
    return { x: x(i), y: yTime(ms) };
  };
  const runs = averageRuns(bars, mode);
  const covered =
    mode === 'daily' ? Math.min(DAILY_DAYS, days.length) : days.length;
  return (
    <section aria-labelledby="chart-title" className="tp-chart">
      <div className="tp-chart-header">
        <div>
          <h2 id="chart-title">Settled payments</h2>
          <p className="tp-muted">
            {mode === 'daily' ? 'Per day' : 'Per week'} · UTC · last {covered}{' '}
            days
          </p>
        </div>
        <div className="tp-toggle" role="group" aria-label="Chart period">
          {(['daily', 'weekly'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
              }}
            >
              {value === 'daily' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>
      </div>
      <div ref={plotRef} className="tp-chart-plot">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Settled payments per ${mode === 'daily' ? 'day' : 'week'}, scheduled and visitor purchases stacked, with the average time to settle as dots joined across consecutive ${mode === 'daily' ? 'days' : 'weeks'}`}
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
                x={pad.left - 6}
                y={y(countMax * fraction) + 4}
                textAnchor="end"
              >
                {Math.round(countMax * fraction)}
              </text>
              <text
                className="tp-chart-text tp-chart-time"
                x={width - pad.right + 6}
                y={y(countMax * fraction) + 4}
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
          {runs
            .filter((run) => run.length > 1)
            .map((run) => (
              <polyline
                key={`line-${run[0]}`}
                className="tp-chart-line"
                points={run
                  .map(
                    (i) => `${point(i).x.toFixed(1)},${point(i).y.toFixed(1)}`,
                  )
                  .join(' ')}
              />
            ))}
          {runs.flat().map((i) => (
            <circle
              key={`dot-${i}`}
              className="tp-chart-dot"
              cx={point(i).x.toFixed(1)}
              cy={point(i).y.toFixed(1)}
              r="4"
            >
              <title>
                {`${bars[i]?.label}: average ${seconds(bars[i]?.averageMs ?? 0)}`}
              </title>
            </circle>
          ))}
          {labelIndexes(bars.length, plotWidth).map((index) => {
            const bar = bars[index];
            return bar ? (
              <text
                key={bar.key}
                className="tp-chart-text"
                x={x(index)}
                y={height - 8}
                textAnchor="middle"
              >
                {bar.key.slice(5)}
              </text>
            ) : null;
          })}
        </svg>
      </div>
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
