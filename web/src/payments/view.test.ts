import { describe, expect, it } from 'vitest';
import {
  stageView,
  isVisitorOrder,
  purchaseMessage,
  money,
  confirmationLabel,
  railBadge,
  stepsFor,
  cardRail,
} from './view';
import { payment } from './test-fixtures';

describe('payment views', () => {
  it.each([
    ['sent', 'Sent', -1, false],
    ['received', 'Received', 0, false],
    ['confirming', 'Confirming', 1, false],
    ['settled', 'Settled', 2, true],
    ['notified', 'Shop notified', 3, true],
  ] as const)(
    'maps %s to its actual terminal stage without advancing it',
    (stage, label, step, paid) => {
      expect(
        stageView({ stage, confirmations: 3, final: false }, 7),
      ).toMatchObject({
        label,
        step,
        paid,
        confirmationLabel: '3 of 7',
      });
    },
  );
  it('keeps finality separate from settlement and bounds only the visual bar', () => {
    expect(
      stageView({ stage: 'settled', confirmations: 24, final: false }, 7),
    ).toMatchObject({
      paid: true,
      final: false,
      progress: 1,
      confirmationLabel: '7+ confirmations',
    });
    expect(
      stageView({ stage: 'received', confirmations: 0, final: false }, 7)
        .progress,
    ).toBe(0);
    expect(
      stageView({ stage: 'notified', confirmations: 24, final: true }, 7).final,
    ).toBe(true);
  });
  it('highlights only the exact order returned to this visitor, including after reconnect', () => {
    expect(isVisitorOrder({ orderId: 'mine' }, new Set(['mine']))).toBe(true);
    expect(
      isVisitorOrder({ orderId: 'another-visitor' }, new Set(['mine'])),
    ).toBe(false);
    expect(isVisitorOrder({ orderId: null }, new Set(['mine']))).toBe(false);
    expect(isVisitorOrder({ orderId: 'mine' }, new Set())).toBe(false);
  });
  it('counts confirmations up to the threshold, then stops counting', () => {
    expect(confirmationLabel(4, 10)).toBe('4 of 10');
    expect(confirmationLabel(10, 10)).toBe('10+ confirmations');
    expect(confirmationLabel(1806, 10)).toBe('10+ confirmations');
  });
  it('says which limit applies and when it lifts', () => {
    expect(purchaseMessage(429, 'rate_limited', '17')).toBe(
      "You've made a lot of test purchases. Try again in 17 seconds.",
    );
    expect(purchaseMessage(429, 'rate_limited', '1.2')).toContain('2 seconds');
    expect(purchaseMessage(429, 'rate_limited', null)).not.toContain('NaN');
    expect(purchaseMessage(429, 'busy', '2')).toBe(
      'Lots of test purchases right now. Try again in a moment.',
    );
    expect(purchaseMessage(409, 'daily_limit', null)).toBe(
      "Today's test purchases are used up. Back at 00:00 UTC.",
    );
    expect(purchaseMessage(503, 'paused', null)).toBe(
      'The demo account is being topped up. Try again soon.',
    );
    expect(purchaseMessage(503, 'purchases_unavailable', null)).toBe(
      'Demo offline',
    );
    expect(purchaseMessage(500, undefined, null)).toBe('Demo offline');
  });
  it('formats large micro-unit prices without floating-point rounding', () => {
    expect(money('14000000')).toBe('$14.00');
    expect(money('9007199254740991000000')).toBe('$9007199254740991.00');
  });
  it.each([
    ['sent', 'Sent', 0, 'blue'],
    ['processing', 'Processing', 1, 'orange'],
    ['settled', 'Settled', 2, 'green'],
    ['notified', 'Shop notified', 3, 'purple'],
  ] as const)(
    'maps a card payment at %s to its stage',
    (stage, label, step, color) => {
      expect(
        stageView(
          { stage, confirmations: 0, final: false, provider: 'stripe' },
          7,
        ),
      ).toMatchObject({ label, step, color });
    },
  );
  it('reads the card stages as Sent, Processing, Settled, Notified', () => {
    expect(stepsFor('stripe').map((s) => s.stage)).toEqual([
      'sent',
      'processing',
      'settled',
      'notified',
    ]);
    expect(stepsFor('chain').map((s) => s.stage)).toEqual([
      'received',
      'confirming',
      'settled',
      'notified',
    ]);
  });
  it('names the rail on a receipt', () => {
    expect(railBadge(payment())).toBe('Test network');
    expect(
      railBadge(
        payment({
          provider: 'stripe',
          order: {
            id: 'o1',
            item: 'Duck',
            price: '500000',
            customer: { cardBrand: 'visa', cardLast4: '4242' },
          },
        }),
      ),
    ).toBe('Test card · Visa ····4242');
    expect(
      railBadge(
        payment({
          provider: 'stripe',
          order: {
            id: 'o1',
            item: 'Duck',
            price: '500000',
            customer: { cardBrand: 'amex', cardLast4: '0005' },
          },
        }),
      ),
    ).toBe('Test card · American Express ····0005');
    expect(railBadge(payment({ provider: 'stripe', order: null }))).toBe(
      'Test card',
    );
  });
  it('offers the card only once /health says a card is saved', () => {
    expect(cardRail(null)).toBe('checking');
    expect(cardRail({ cardAvailable: false })).toBe('unavailable');
    expect(cardRail({ cardAvailable: true })).toBe('available');
  });
  it('maps a card payment without a confirmation threshold', () => {
    const view = stageView({
      stage: 'processing',
      confirmations: 0,
      final: false,
      provider: 'stripe',
    });
    expect(view).toMatchObject({ label: 'Processing', step: 1, paid: false });
    expect(view).not.toHaveProperty('progress');
    expect(view).not.toHaveProperty('confirmationLabel');
  });
  it('says when the test card is unavailable', () => {
    expect(purchaseMessage(503, 'card_unavailable', null)).toBe(
      'Test card payments are unavailable right now. Try the test network.',
    );
  });
});
