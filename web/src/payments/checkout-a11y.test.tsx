// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChainTerminal } from './chain-terminal';
import { Checkout } from './checkout';
import type { PurchaseAnswer } from './client';
import { RailChoice } from './rail-choice';
import { health, payment } from './test-fixtures';
import type { Dashboard } from './types';

const data: Dashboard = {
  payments: [],
  receipts: [],
  stats: {
    settledCount: 0,
    averageTimeToSettleMs: null,
    duplicatesSkipped: 0,
    failuresRecovered: 0,
  },
  daily: [],
  health: health({ cardAvailable: true }),
  olderReceipts: 'none',
  olderFailed: false,
};
const purchase = vi.fn(
  (): Promise<PurchaseAnswer> =>
    new Promise(() => {
      // The answer never arrives, so the checkout stays busy.
    }),
);

vi.mock('./use-payments', () => ({
  usePayments: () => ({ status: 'live', data, showMoreReceipts: () => {} }),
  paymentsClient: () => ({
    purchase,
    refresh: () => Promise.resolve(),
    baseUrl: '/api',
    onOrderUpdate: () => () => {},
  }),
}));

afterEach(() => {
  cleanup();
  purchase.mockClear();
});

describe('checkout accessibility', () => {
  it('moves focus to the drawer heading when the counter opens', () => {
    render(<Checkout apiBaseUrl="/api" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the counter' }));
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'How would you like to pay?' }),
    );
  });

  it('keeps the chosen rail focusable and ignores clicks while busy', () => {
    render(<Checkout apiBaseUrl="/api" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the counter' }));
    const chain = screen.getByRole('button', {
      name: 'Pay on the test network',
    });
    chain.focus();
    fireEvent.click(chain);
    expect(purchase).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole('button', { name: 'Placing your order…' });
    expect(busy).toBe(chain);
    expect(busy).not.toHaveProperty('disabled', true);
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(busy);
    const other = screen.getByRole('button', { name: 'Pay with a test card' });
    expect(other).not.toHaveProperty('disabled', true);
    expect(other.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(busy);
    fireEvent.click(other);
    expect(purchase).toHaveBeenCalledTimes(1);
  });

  it('does not choose a rail marked unavailable', () => {
    const onChoose = vi.fn();
    render(<RailChoice card="checking" disabled={false} onChoose={onChoose} />);
    const card = screen.getByRole('button', { name: 'Pay with a test card' });
    const chain = screen.getByRole('button', {
      name: 'Pay on the test network',
    });
    expect(card.getAttribute('aria-disabled')).toBe('true');
    expect(chain.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(card);
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(chain);
    expect(onChoose).toHaveBeenCalledWith('chain');
  });

  it('labels the terminal as a group and announces stage changes politely', () => {
    const { rerender } = render(
      <ChainTerminal payment={payment({ stage: 'received' })} threshold={7} />,
    );
    const terminal = screen.getByRole('group', { name: 'Payment terminal' });
    const live = terminal.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('Received');
    rerender(
      <ChainTerminal
        payment={payment({ stage: 'confirming', confirmations: 3 })}
        threshold={7}
      />,
    );
    expect(terminal.querySelector('[aria-live="polite"]')).toBe(live);
    expect(
      [...(live?.querySelectorAll('strong:not([aria-hidden])') ?? [])].map(
        (label) => label.textContent,
      ),
    ).toEqual([expect.stringContaining('Confirming')]);
  });
});
