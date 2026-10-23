import { createHash } from 'node:crypto';
import { utcDateKey } from './time';

export type Budget = { count: number; amount: bigint };

const randomScale = 1n << 32n;

export function dailyTarget(cap: Budget, day: Date, seed: string): Budget {
  if (!Number.isSafeInteger(cap.count) || cap.count < 0 || cap.amount < 0n) {
    throw new RangeError('Daily caps must be nonnegative integers');
  }
  const hash = createHash('sha256')
    .update(JSON.stringify([utcDateKey(day), seed]))
    .digest();
  const countFactor = BigInt(5000 + (hash.readUInt32BE(0) % 5001));
  const amountFactor = BigInt(5000 + (hash.readUInt32BE(4) % 5001));
  return {
    count: Number((BigInt(cap.count) * countFactor) / 10000n),
    amount: (cap.amount * amountFactor) / 10000n,
  };
}

export function shouldBuyThisMinute(
  remaining: Budget,
  expectedSize: bigint,
  activeMinutesLeft: number,
  isQuiet: boolean,
  rng: () => number,
): boolean {
  if (
    remaining.count <= 0 ||
    expectedSize <= 0n ||
    remaining.amount < expectedSize ||
    activeMinutesLeft <= 0
  )
    return false;
  const draw = BigInt(Math.floor(rng() * Number(randomScale)));
  const minutes = BigInt(activeMinutesLeft) * (isQuiet ? 10n : 1n);
  return (
    draw * minutes < BigInt(remaining.count) * randomScale &&
    draw * minutes * expectedSize < remaining.amount * randomScale
  );
}

function randomBelow(limit: bigint, rng: () => number): bigint {
  const words = Math.ceil(limit.toString(2).length / 32);
  const range = 1n << BigInt(words * 32);
  const cutoff = range - (range % limit);
  for (;;) {
    let draw = 0n;
    for (let word = 0; word < words; word++) {
      draw = (draw << 32n) + BigInt(Math.floor(rng() * Number(randomScale)));
    }
    if (draw < cutoff) return draw % limit;
  }
}

export function sampleAmountCents(
  min: bigint,
  max: bigint,
  rng: () => number,
): bigint {
  if (min <= 0n || max < min) {
    throw new RangeError('Sampling bounds must be positive and ordered');
  }
  if (min === max) return min;
  for (;;) {
    const candidate = min + randomBelow(max - min + 1n, rng);
    if (randomBelow(candidate, rng) < min) return candidate;
  }
}
