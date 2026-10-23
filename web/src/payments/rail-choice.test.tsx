import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RailChoice } from './rail-choice';

const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => ({
    tag: m[0],
    label: m[1],
  }));

describe('RailChoice', () => {
  it('offers the test network and the test card as full-width buttons', () => {
    const html = renderToStaticMarkup(
      <RailChoice card="available" disabled={false} onChoose={() => {}} />,
    );
    expect(buttons(html).map((b) => b.label)).toEqual([
      'Pay on the test network',
      'Pay with a test card',
    ]);
    for (const button of buttons(html))
      expect(button.tag).toContain('tp-rail-button');
  });
  it('hides the card button while the card rail is unavailable', () => {
    const html = renderToStaticMarkup(
      <RailChoice card="unavailable" disabled={false} onChoose={() => {}} />,
    );
    expect(buttons(html).map((b) => b.label)).toEqual([
      'Pay on the test network',
    ]);
  });
  it('holds the card button in place, disabled, until /health answers', () => {
    const html = renderToStaticMarkup(
      <RailChoice card="checking" disabled={false} onChoose={() => {}} />,
    );
    const [chain, card] = buttons(html);
    expect(card?.label).toBe('Pay with a test card');
    expect(card?.tag).toContain('disabled');
    expect(chain?.tag).not.toContain('disabled');
  });
  it('shows progress on the chosen rail and disables both', () => {
    const html = renderToStaticMarkup(
      <RailChoice
        card="available"
        disabled
        chosen="card"
        busyLabel="Placing your order…"
        onChoose={() => {}}
      />,
    );
    expect(buttons(html)).toEqual([
      expect.objectContaining({ label: 'Pay on the test network' }),
      expect.objectContaining({ label: 'Placing your order…' }),
    ]);
    for (const button of buttons(html))
      expect(button.tag).toContain('disabled');
  });
});
