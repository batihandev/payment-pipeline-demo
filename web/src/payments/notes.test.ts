import { describe, expect, it } from 'vitest';
import { receiptNote } from './notes';
import { incident, payment } from './test-fixtures';

const reorgNote =
  'The block with this payment was replaced, so the tracker checked it again.';
const failedNote = 'This payment did not go through, so nothing was credited.';
const lateNote = 'Paid after the order expired, and still credited.';
const donationNote =
  'Thank you for the donation. Only test USDC transfers show here.';

describe('receiptNote', () => {
  it.each(['payment_reorg', 'settled_reorg'])('explains a %s', (kind) => {
    expect(receiptNote(payment(), [incident(kind)])).toBe(reorgNote);
  });
  it.each(['send_reverted', 'send_dropped'])('explains a %s', (kind) => {
    expect(receiptNote(payment(), [incident(kind)])).toBe(failedNote);
  });
  it('explains a payment after expiry', () => {
    expect(receiptNote(payment(), [incident('paid_after_expiry')])).toBe(
      lateNote,
    );
  });
  it('thanks the donor', () => {
    expect(receiptNote(payment({ donation: true }), [])).toBe(donationNote);
  });
  it('prefers the reorg note when several apply', () => {
    expect(
      receiptNote(payment({ donation: true }), [
        incident('paid_after_expiry'),
        incident('send_reverted'),
        incident('settled_reorg'),
      ]),
    ).toBe(reorgNote);
  });
  it('ignores incidents of other payments', () => {
    expect(
      receiptNote(payment(), [incident('payment_reorg', 'other-payment')]),
    ).toBeNull();
  });
  it('shows nothing for internal incidents', () => {
    const internal = [
      'notice_failed',
      'duplicate',
      'nonce_resynced',
      'send_failed',
      'rate_limit',
      'refilled',
      'swept',
    ].map((kind) => incident(kind));
    expect(receiptNote(payment(), internal)).toBeNull();
  });
});
