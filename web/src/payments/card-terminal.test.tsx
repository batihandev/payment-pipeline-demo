import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardTerminal } from './card-terminal';
import { payment } from './test-fixtures';

const card = (overrides = {}) =>
  payment({
    provider: 'stripe',
    stage: 'processing',
    confirmations: 0,
    blockNumber: null,
    order: {
      id: 'o1',
      item: 'Duck',
      price: '500000',
      customer: { cardBrand: 'visa', cardLast4: '4242' },
    },
    ...overrides,
  });

describe('CardTerminal', () => {
  it('shows the test card tapping the terminal and the card stage', () => {
    const html = renderToStaticMarkup(<CardTerminal payment={card()} />);
    expect(html).toContain('TEST CARD');
    expect(html).toContain('tp-tap-card');
    expect(html).toContain('Visa');
    expect(html).toContain('····4242');
    expect(html).toContain('Processing');
  });
  it('has no block stack and no confirmation bar', () => {
    const html = renderToStaticMarkup(
      <CardTerminal payment={card({ stage: 'settled', final: true })} />,
    );
    expect(html).toContain('Settled');
    expect(html).toContain('Final');
    expect(html).not.toContain('tp-block-stack');
    expect(html).not.toContain('progressbar');
  });
});
