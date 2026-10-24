import { expect, it } from 'vitest';
import { catalogue } from './catalogue';

it('prices every item between $0.50 and $2.00', () => {
  for (const item of catalogue) {
    expect(item.priceCents).toBeGreaterThanOrEqual(50n);
    expect(item.priceCents).toBeLessThanOrEqual(200n);
  }
});
