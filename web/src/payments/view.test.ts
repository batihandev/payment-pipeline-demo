import { describe, expect, it } from 'vitest';
import { stageView, isVisitorOrder, purchaseMessage, money } from './view';

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
        confirmationLabel: '3 of 7 confirmations',
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
      confirmationLabel: '24 of 7 confirmations',
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
  it('explains the exhausted budget and uses the server cooldown in seconds', () => {
    expect(purchaseMessage(409, null)).toContain('budget');
    expect(purchaseMessage(429, '17')).toContain('17 seconds');
    expect(purchaseMessage(429, null)).not.toContain('NaN');
    expect(purchaseMessage(503, null)).toBe('Demo offline');
  });
  it('formats large micro-unit prices without floating-point rounding', () => {
    expect(money('14000000')).toBe('$14.00');
    expect(money('9007199254740991000000')).toBe('$9007199254740991.00');
  });
});
