import { catalogue } from './catalogue';

it('offers twenty distinct items with positive whole-cent prices', () => {
  expect(catalogue).toHaveLength(20);
  expect(new Set(catalogue.map((item) => item.name)).size).toBe(20);
  for (const item of catalogue) {
    expect(item.name.length).toBeGreaterThan(0);
    expect(item.priceCents).toBeGreaterThan(0n);
    expect(typeof item.priceCents).toBe('bigint');
  }
});
