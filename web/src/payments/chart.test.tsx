import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettledChart } from './chart';
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
const days = [
  day('2026-10-10', 1, 0, 5000),
  day('2026-10-11', 1, 0, 7000),
  day('2026-10-12', 0, 0),
  day('2026-10-13', 1, 0, 6000),
  day('2026-10-15', 2, 0, 9000),
  day('2026-10-16', 1, 1, 8000),
];

describe('SettledChart', () => {
  it('draws one line per run of consecutive days', () => {
    const html = renderToStaticMarkup(<SettledChart days={days} />);
    expect(html.match(/<circle /g)).toHaveLength(5);
    expect(html.match(/<polyline /g)).toHaveLength(2);
  });
  it('titles each dot with its day and average', () => {
    const html = renderToStaticMarkup(<SettledChart days={days} />);
    expect(html).toMatch(
      /<circle[^>]*class="tp-chart-dot"[^>]*><title>2026-10-10: average 5s<\/title><\/circle>/,
    );
    expect(html.match(/<circle[^>]*><title>/g)).toHaveLength(5);
  });
  it('renders on the server without a layout-effect warning', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderToStaticMarkup(<SettledChart days={days} />);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
