import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Receipt } from './receipt';
import { payment } from './test-fixtures';

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
});
