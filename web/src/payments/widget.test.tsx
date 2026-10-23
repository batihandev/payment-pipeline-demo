import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { payment } from './test-fixtures';
import type { Dashboard } from './types';

const data: Dashboard = {
  payments: [
    payment({
      donation: true,
      donorName: 'Teal Otter',
      noteKinds: ['payment_reorg'],
    }),
  ],
  stats: {
    settledCount: 1,
    averageTimeToSettleMs: null,
    duplicatesSkipped: 0,
    failuresRecovered: 0,
  },
  daily: [],
  health: null,
  get receipts() {
    return this.payments;
  },
  olderReceipts: 'none',
  olderFailed: false,
};

let current: { status: string; data: Dashboard | null } = {
  status: 'live',
  data,
};
vi.mock('./use-payments', () => ({
  usePayments: () => current,
}));

describe('PaymentsWidget', () => {
  it('renders nothing before data arrives', async () => {
    current = { status: 'loading', data: null };
    const { PaymentsWidget } = await import('./widget');
    expect(renderToStaticMarkup(<PaymentsWidget apiBaseUrl="/api" />)).toBe('');
  });
  it('renders nothing when offline', async () => {
    current = { status: 'offline', data: null };
    const { PaymentsWidget } = await import('./widget');
    expect(renderToStaticMarkup(<PaymentsWidget apiBaseUrl="/api" />)).toBe('');
  });
  it('shows a donation heading and no note', async () => {
    current = { status: 'live', data };
    const { PaymentsWidget } = await import('./widget');
    const html = renderToStaticMarkup(<PaymentsWidget apiBaseUrl="/api" />);
    expect(html).toContain('Donation from Teal Otter');
    expect(html).not.toContain('tp-note');
  });
  it('heads the widget with wording that fits both rails', async () => {
    current = { status: 'live', data };
    const { PaymentsWidget } = await import('./widget');
    const html = renderToStaticMarkup(<PaymentsWidget apiBaseUrl="/api" />);
    expect(html).toMatch(/<header[^>]*>.*Test payments.*<\/header>/);
    expect(html).not.toMatch(/<header[^>]*>.*Test network.*<\/header>/);
  });
});
