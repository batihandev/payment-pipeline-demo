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
};

vi.mock('./use-payments', () => ({
  usePayments: () => ({ status: 'live', data }),
}));

describe('PaymentsWidget', () => {
  it('shows a donation heading and no note', async () => {
    const { PaymentsWidget } = await import('./widget');
    const html = renderToStaticMarkup(<PaymentsWidget apiBaseUrl="/api" />);
    expect(html).toContain('Donation from Teal Otter');
    expect(html).not.toContain('tp-note');
  });
});
