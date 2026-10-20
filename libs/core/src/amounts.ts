const maxOffset = 9999;

export function allocateOffset(taken: Set<number>, rng: () => number): number {
  const start = Math.floor(rng() * maxOffset);
  for (let step = 0; step < maxOffset; step++) {
    const offset = ((start + step) % maxOffset) + 1;
    if (!taken.has(offset)) return offset;
  }
  throw new Error('No amount offsets available');
}

export function expectedAmount(priceCents: bigint, offset: number): bigint {
  if (
    priceCents < 0n ||
    !Number.isInteger(offset) ||
    offset < 1 ||
    offset > maxOffset
  ) {
    throw new RangeError('Price must be nonnegative and offset must be 1–9999');
  }
  return priceCents * 10000n + BigInt(offset);
}
