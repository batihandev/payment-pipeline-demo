import { expect, it } from 'vitest';
import { dailyTarget, sampleAmountCents, shouldBuyThisMinute } from './pacing';

function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

it('keeps daily targets within both caps and stable for the same UTC day', () => {
  const cap = { count: 20, amount: 100000000n };
  const targets = new Set<string>();
  for (let day = 1; day <= 28; day++) {
    const date = new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`);
    const target = dailyTarget(cap, date, 'daily-seed');
    expect(target.count).toBeGreaterThanOrEqual(0);
    expect(target.count).toBeLessThanOrEqual(cap.count);
    expect(target.amount).toBeGreaterThanOrEqual(0n);
    expect(target.amount).toBeLessThanOrEqual(cap.amount);
    expect(
      dailyTarget(cap, new Date(date.getTime() + 3600000), 'daily-seed'),
    ).toEqual(target);
    targets.add(`${target.count}:${target.amount}`);
  }
  expect(targets.size).toBeGreaterThan(1);
  expect(
    dailyTarget({ count: 0, amount: 0n }, new Date('2026-10-20'), 'seed'),
  ).toEqual({ count: 0, amount: 0n });
});

it('stays within the target over full days and buys less often in quiet minutes', () => {
  let quietPurchases = 0;
  let activePurchases = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const target = dailyTarget(
      { count: 80, amount: 400000000n },
      new Date('2026-10-20'),
      String(seed),
    );
    const remaining = { ...target };
    const rng = seededRng(seed);
    for (let minute = 0; minute < 1440; minute++) {
      const quiet = minute < 420;
      const activeMinutesLeft = 1440 - Math.max(minute, 420);
      const amount = sampleAmountCents(100n, 1000n, rng) * 10000n;
      if (
        amount <= remaining.amount &&
        shouldBuyThisMinute(remaining, 4000000n, activeMinutesLeft, quiet, rng)
      ) {
        remaining.count--;
        remaining.amount -= amount;
        if (quiet) quietPurchases++;
        else activePurchases++;
      }
      expect(remaining.count).toBeGreaterThanOrEqual(0);
      expect(remaining.amount).toBeGreaterThanOrEqual(0n);
    }
  }
  expect(activePurchases).toBeGreaterThan(1000);
  expect(quietPurchases / (100 * 420)).toBeLessThan(
    activePurchases / (100 * 1020) / 2,
  );
});

it('refuses purchases with no count, insufficient expected amount or no active minutes', () => {
  expect(
    shouldBuyThisMinute({ count: 0, amount: 100n }, 10n, 1, false, () => 0),
  ).toBe(false);
  expect(
    shouldBuyThisMinute({ count: 1, amount: 9n }, 10n, 1, false, () => 0),
  ).toBe(false);
  expect(
    shouldBuyThisMinute({ count: 1, amount: 10n }, 10n, 0, false, () => 0),
  ).toBe(false);
  expect(
    shouldBuyThisMinute({ count: 1, amount: 10n }, 10n, 1, false, () => 0.99),
  ).toBe(true);
});

it('uses both the remaining count and amount when deciding a purchase', () => {
  expect(
    shouldBuyThisMinute({ count: 1, amount: 1000n }, 10n, 10, false, () => 0.2),
  ).toBe(false);
  expect(
    shouldBuyThisMinute({ count: 100, amount: 10n }, 10n, 10, false, () => 0.2),
  ).toBe(false);
  expect(
    shouldBuyThisMinute(
      { count: 100, amount: 1000n },
      10n,
      10,
      false,
      () => 0.2,
    ),
  ).toBe(true);
  expect(
    shouldBuyThisMinute(
      { count: 100, amount: 1000n },
      10n,
      10,
      true,
      () => 0.2,
    ),
  ).toBe(true);
  expect(
    shouldBuyThisMinute({ count: 1, amount: 10n }, 10n, 1, true, () => 0.2),
  ).toBe(false);
});

it('samples whole cents within bounds with equal frequency across logarithmic bands', () => {
  const rng = seededRng(42);
  let lowerBand = 0;
  for (let i = 0; i < 6000; i++) {
    const cents = sampleAmountCents(100n, 9999n, rng);
    expect(cents).toBeGreaterThanOrEqual(100n);
    expect(cents).toBeLessThanOrEqual(9999n);
    if (cents < 1000n) lowerBand++;
  }
  expect(lowerBand).toBeGreaterThan(2700);
  expect(lowerBand).toBeLessThan(3300);
  expect(sampleAmountCents(731n, 731n, rng)).toBe(731n);
});

it('rejects nonpositive or reversed sampling bounds', () => {
  expect(() => sampleAmountCents(0n, 100n, () => 0)).toThrow(RangeError);
  expect(() => sampleAmountCents(100n, 1n, () => 0)).toThrow(RangeError);
});
