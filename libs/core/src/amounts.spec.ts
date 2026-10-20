import { allocateOffset, expectedAmount } from './amounts';

it('never allocates a taken offset even when the random choice collides', () => {
  const taken = new Set([1, 2, 9999]);
  expect(allocateOffset(taken, () => 0)).toBe(3);
  expect(allocateOffset(taken, () => 0.999999)).toBe(3);
  expect(taken).toEqual(new Set([1, 2, 9999]));
});

it('finds the only available offset in the full allocation range', () => {
  const taken = new Set(Array.from({ length: 9999 }, (_, i) => i + 1));
  taken.delete(731);
  expect(allocateOffset(taken, () => 0.8)).toBe(731);
});

it('rejects allocation when every offset is taken', () => {
  const taken = new Set(Array.from({ length: 9999 }, (_, i) => i + 1));
  expect(() => allocateOffset(taken, () => 0)).toThrow(
    'No amount offsets available',
  );
});

it('adds offset 731 to fourteen dollars as 14000731 micro-units', () => {
  expect(expectedAmount(1400n, 731)).toBe(14000731n);
});

it('preserves exact amounts above the safe integer range', () => {
  expect(expectedAmount(9007199254740993n, 9999)).toBe(90071992547409939999n);
});

it('rejects negative prices and offsets outside the allocation range', () => {
  expect(() => expectedAmount(-1n, 1)).toThrow(RangeError);
  for (const offset of [0, 10000, 1.5, NaN]) {
    expect(() => expectedAmount(1400n, offset)).toThrow(RangeError);
  }
});
