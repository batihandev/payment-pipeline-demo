import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Receipt, StepStrip } from './receipt';
import { payment } from './test-fixtures';

const cardPayment = (overrides = {}) =>
  payment({
    provider: 'stripe',
    confirmations: 0,
    blockNumber: null,
    receiptUrl: 'https://pay.stripe.com/receipts/1',
    order: {
      id: 'o1',
      item: 'Duck',
      price: '500000',
      customer: { cardBrand: 'visa', cardLast4: '4242' },
    },
    ...overrides,
  });

describe('Receipt', () => {
  it('names a donation after its donor', () => {
    const html = renderToStaticMarkup(
      <Receipt
        payment={payment({ donation: true, donorName: 'Teal Otter' })}
        threshold={7}
      />,
    );
    expect(html).toContain('Donation from Teal Otter');
    expect(html).toContain('Payment #5f0c1c9e');
  });
  it('renders the note once', () => {
    const html = renderToStaticMarkup(
      <Receipt payment={payment()} threshold={7} note="A note." />,
    );
    expect(html.match(/tp-note/g)).toHaveLength(1);
    expect(html).toContain('A note.');
  });
  it('renders no note element without a note', () => {
    expect(
      renderToStaticMarkup(
        <Receipt payment={payment()} threshold={7} note={null} />,
      ),
    ).not.toContain('tp-note');
  });
  it('badges a chain receipt with the test network and keeps its confirmation bar', () => {
    const html = renderToStaticMarkup(
      <Receipt
        payment={payment({ explorerUrl: 'https://example.com/tx/1' })}
        threshold={7}
      />,
    );
    expect(html).toContain('Test network');
    expect(html).toContain('progressbar');
    expect(html).toContain('View on explorer');
  });
  it('badges a card receipt with the card and links the Stripe receipt instead of a block', () => {
    const html = renderToStaticMarkup(
      <Receipt payment={cardPayment()} threshold={7} />,
    );
    expect(html.replaceAll(/<[^>]+>/g, '')).toContain(
      'Test card · Visa ····4242',
    );
    expect(html).toContain('href="https://pay.stripe.com/receipts/1"');
    expect(html).toContain('View Stripe receipt');
    expect(html).not.toContain('progressbar');
    expect(html).not.toContain('View on explorer');
    expect(html).not.toContain('block');
  });
  it('keeps the last four digits visible on a long brand', () => {
    const html = renderToStaticMarkup(
      <Receipt
        payment={cardPayment({
          order: {
            id: 'o1',
            item: 'Duck',
            price: '500000',
            customer: { cardBrand: 'cartes_bancaires', cardLast4: '4242' },
          },
        })}
        threshold={7}
      />,
    );
    expect(html).toMatch(
      /<span class="tp-rail-brand">Test card · Cartes bancaires<\/span> <span class="tp-rail-last4">····4242<\/span>/,
    );
  });
  it('leaves out the Stripe link until the receipt exists', () => {
    const html = renderToStaticMarkup(
      <Receipt payment={cardPayment({ receiptUrl: null })} threshold={7} />,
    );
    expect(html).not.toContain('View Stripe receipt');
  });
});

describe('Receipt link', () => {
  it('links the Stripe receipt only over https', () => {
    for (const receiptUrl of [
      'http://pay.stripe.com/receipts/1',
      'javascript:alert(1)',
      '//pay.stripe.com/receipts/1',
    ])
      expect(
        renderToStaticMarkup(
          <Receipt payment={cardPayment({ receiptUrl })} threshold={7} />,
        ),
      ).not.toContain('View Stripe receipt');
  });
});

describe('StepStrip', () => {
  const labels = (html: string) =>
    [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]);
  it('reads Sent, Processing, Settled, Notified for a card payment', () => {
    const html = renderToStaticMarkup(
      <StepStrip payment={cardPayment({ stage: 'processing' })} />,
    );
    expect(labels(html)).toEqual(['Sent', 'Processing', 'Settled', 'Notified']);
    expect(html.match(/tp-reached/g)).toHaveLength(2);
  });
  it('ends the strip on Failed for a failed card payment', () => {
    const html = renderToStaticMarkup(
      <StepStrip payment={cardPayment({ stage: 'failed', final: true })} />,
    );
    expect(labels(html)).toEqual(['Sent', 'Processing', 'Failed']);
    expect(html).toContain('tp-failed');
  });
  it('labels a failed card payment Failed, not Final', () => {
    const html = renderToStaticMarkup(
      <Receipt
        payment={cardPayment({ stage: 'failed', final: true })}
        threshold={7}
      />,
    );
    expect(html).toContain('>Failed<');
    expect(html).not.toContain('>Final<');
    expect(html).not.toContain('PAID');
  });
  it('keeps the chain stages for a chain payment', () => {
    expect(
      labels(renderToStaticMarkup(<StepStrip payment={payment()} />)),
    ).toEqual(['Received', 'Confirming', 'Settled', 'Notified']);
  });
});
