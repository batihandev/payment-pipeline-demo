import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { payment } from './payments/test-fixtures';
import type { Dashboard } from './payments/types';

const data: Dashboard = {
  payments: [
    payment({
      donation: true,
      donorName: 'Teal Otter',
      noteKinds: ['send_reverted'],
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

vi.mock('./payments/use-payments', () => ({
  usePayments: () => ({ status: 'live', data }),
}));

describe('PaymentsPanel', () => {
  it('has no incident list and puts one note on the receipt', async () => {
    const { PaymentsPanel } = await import('./panel');
    const html = renderToStaticMarkup(<PaymentsPanel apiBaseUrl="/api" />);
    expect(html).not.toContain('What went wrong today');
    expect(html).toContain('Donation from Teal Otter');
    expect(html).toContain(
      'This payment did not go through, so nothing was credited.',
    );
  });
  it('shows no balance warning when an account runs low', async () => {
    const low = { native: '0', usdc: '0', lowNative: true, lowUsdc: true };
    data.health = {
      confirmations: 10,
      head: '100',
      cursor: '100',
      lag: '0',
      openGaps: 0,
      queueDepth: null,
      cooldowns: null,
      balances: { buyer: low, shop: low },
      chainError: null,
      cardAvailable: false,
    };
    const { PaymentsPanel } = await import('./panel');
    const html = renderToStaticMarkup(<PaymentsPanel apiBaseUrl="/api" />);
    data.health = null;
    expect(html).not.toContain('running low');
  });
});
