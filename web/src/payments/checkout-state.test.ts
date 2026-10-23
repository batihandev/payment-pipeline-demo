import { describe, expect, it } from 'vitest';
import { checkoutState } from './checkout-state';
import { payment } from './test-fixtures';

const note = 'This payment did not go through, so nothing was credited.';
const waiting = {
  status: 'live' as const,
  orderId: 'o1',
  payment: undefined,
  paid: false,
  order: { position: 0, closed: false },
  sending: false,
  message: '',
};

describe('checkoutState', () => {
  it('keeps the checkout busy while an accepted order waits to be sent', () => {
    expect(checkoutState(waiting)).toEqual({
      busy: true,
      closed: false,
      busyLabel: 'Your purchase is in progress',
      statusText: 'Order accepted. Waiting for the payment to be sent.',
    });
  });
  it('reopens the checkout when the card is declined before a payment exists', () => {
    expect(
      checkoutState({
        ...waiting,
        order: { position: 0, closed: true },
        message: 'Your order was accepted. Sending is pending; please wait.',
      }),
    ).toEqual({
      busy: false,
      closed: true,
      busyLabel: undefined,
      statusText: `${note} You can try again.`,
    });
  });
  it('shows the note and reopens the checkout when a payment fails', () => {
    for (const failed of [
      payment({
        provider: 'stripe',
        stage: 'processing',
        orderId: 'o1',
        noteKinds: ['card_failed'],
      }),
      payment({
        stage: 'sent',
        orderId: 'o1',
        noteKinds: ['send_dropped'],
      }),
    ])
      expect(checkoutState({ ...waiting, payment: failed })).toEqual({
        busy: false,
        closed: true,
        busyLabel: undefined,
        statusText: `${note} You can try again.`,
      });
  });
  it('reopens the checkout when the order closes before the failure note arrives', () => {
    const state = checkoutState({
      ...waiting,
      payment: payment({
        provider: 'stripe',
        stage: 'processing',
        orderId: 'o1',
      }),
      order: { position: 0, closed: true },
    });
    expect([state.busy, state.closed, state.statusText]).toEqual([
      false,
      true,
      `${note} You can try again.`,
    ]);
  });
  it('follows a payment that is still moving', () => {
    const state = checkoutState({
      ...waiting,
      payment: payment({ stage: 'confirming', orderId: 'o1' }),
    });
    expect([state.busy, state.closed, state.statusText]).toEqual([
      true,
      false,
      '',
    ]);
  });
  it('reopens the checkout once the payment is paid', () => {
    const state = checkoutState({
      ...waiting,
      payment: payment({ stage: 'settled', orderId: 'o1' }),
      paid: true,
    });
    expect([state.busy, state.closed]).toEqual([false, false]);
  });
  it('shows the queue and the request in progress', () => {
    expect(
      checkoutState({ ...waiting, order: { position: 3, closed: false } })
        .statusText,
    ).toBe('Queued · 2 ahead');
    expect(
      checkoutState({ ...waiting, orderId: undefined, sending: true }),
    ).toEqual({
      busy: true,
      closed: false,
      busyLabel: 'Placing your order…',
      statusText: 'Requesting a test purchase…',
    });
  });
});
