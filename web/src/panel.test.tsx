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
  get receipts() {
    return this.payments;
  },
  olderReceipts: 'none',
  olderFailed: false,
};

vi.mock('./payments/use-payments', () => ({
  usePayments: () => ({ status: 'live', data, showMoreReceipts: () => {} }),
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
  it('counts card payments in a Processing lane and words the header for both rails', async () => {
    const before = data.payments;
    data.payments = [
      payment({
        id: 'c1',
        provider: 'stripe',
        stage: 'processing',
        confirmations: 0,
      }),
      payment({ id: 'c2', provider: 'stripe', stage: 'sent' }),
      payment({ id: 'n1', stage: 'confirming' }),
    ];
    const { PaymentsPanel } = await import('./panel');
    const html = renderToStaticMarkup(<PaymentsPanel apiBaseUrl="/api" />);
    data.payments = before;
    const lanes = [
      ...html.matchAll(/<h2>(\d) · ([^<]+)<\/h2><strong>(\d+)<\/strong>/g),
    ].map((m) => [m[2], Number(m[3])]);
    expect(lanes).toEqual([
      ['Received', 0],
      ['Confirming', 1],
      ['Processing', 1],
      ['Settled', 0],
      ['Shop notified', 0],
    ]);
    expect(html).toContain('1 sent, waiting for the tracker or Stripe.');
    expect(html).not.toContain('awaiting the tracker');
    expect(html).toContain('<span class="tp-network">Test payments</span>');
    expect(html).not.toContain('<span class="tp-network">Test network</span>');
    expect(html).toContain('on a public test network or with a test card');
  });
  it('counts failed payments outside the pipeline lanes', async () => {
    const before = data.payments;
    data.payments = [
      payment({ id: 'f1', provider: 'stripe', stage: 'failed', final: true }),
      payment({ id: 'f2', provider: 'stripe', stage: 'failed', final: true }),
      payment({ id: 'n1', stage: 'confirming' }),
    ];
    const { PaymentsPanel } = await import('./panel');
    const html = renderToStaticMarkup(<PaymentsPanel apiBaseUrl="/api" />);
    data.payments = before;
    const lanes = [
      ...html.matchAll(/<h2>(\d) · ([^<]+)<\/h2><strong>(\d+)<\/strong>/g),
    ].map((m) => [m[2], Number(m[3])]);
    expect(lanes.map(([label]) => label)).not.toContain('Failed');
    expect(lanes.reduce((sum, [, count]) => sum + Number(count), 0)).toBe(1);
    expect(html).toContain('2 did not go through');
  });
  it('offers Show more only while older receipts remain', async () => {
    const { PaymentsPanel } = await import('./panel');
    const render = () =>
      renderToStaticMarkup(<PaymentsPanel apiBaseUrl="/api" />);
    data.olderReceipts = 'more';
    expect(render()).toContain('>Show more</button>');
    data.olderReceipts = 'loading';
    expect(render()).toMatch(/disabled="">Loading older receipts…<\/button>/);
    data.olderReceipts = 'none';
    expect(render()).not.toContain('tp-show-more');
  });
  it('shows a calm line and keeps Show more when older receipts failed', async () => {
    const { PaymentsPanel } = await import('./panel');
    data.olderReceipts = 'more';
    data.olderFailed = true;
    const html = renderToStaticMarkup(<PaymentsPanel apiBaseUrl="/api" />);
    data.olderFailed = false;
    expect(html).toContain('Could not load older receipts. Try again.');
    expect(html).toContain('>Show more</button>');
  });
});
