import { expect, it } from 'vitest';
import { bigintReplacer } from './json';

it('serializes bigints as strings', () => {
  expect(JSON.stringify({ amount: 12n, nested: [3n] }, bigintReplacer)).toBe(
    '{"amount":"12","nested":["3"]}',
  );
});

it('leaves other values unchanged', () => {
  expect(JSON.stringify({ a: 1, b: 'x', c: null }, bigintReplacer)).toBe(
    '{"a":1,"b":"x","c":null}',
  );
});
