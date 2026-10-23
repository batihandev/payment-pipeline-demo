import { describe, expect, it } from 'vitest';
import { receiptNote } from './notes';
import { payment } from './test-fixtures';

const reorgNote =
  'The block with this payment was replaced, so the tracker checked it again.';
const failedNote = 'This payment did not go through, so nothing was credited.';
const lateNote = 'Paid after the order expired, and still credited.';
const donationNote =
  'Thank you for the donation. Only test USDC transfers show here.';

describe('receiptNote', () => {
  it.each(['payment_reorg', 'settled_reorg'] as const)(
    'explains a %s',
    (kind) => {
      expect(receiptNote(payment({ noteKinds: [kind] }))).toBe(reorgNote);
    },
  );
  it.each(['send_reverted', 'send_dropped', 'card_failed'] as const)(
    'explains a %s',
    (kind) => {
      expect(receiptNote(payment({ noteKinds: [kind] }))).toBe(failedNote);
    },
  );
  it('explains a payment after expiry', () => {
    expect(receiptNote(payment({ noteKinds: ['paid_after_expiry'] }))).toBe(
      lateNote,
    );
  });
  it('thanks the donor', () => {
    expect(receiptNote(payment({ donation: true }))).toBe(donationNote);
  });
  it('prefers the reorg note when several apply', () => {
    expect(
      receiptNote(
        payment({
          donation: true,
          noteKinds: ['paid_after_expiry', 'send_reverted', 'settled_reorg'],
        }),
      ),
    ).toBe(reorgNote);
  });
  it('shows nothing for a payment without note kinds', () => {
    expect(receiptNote(payment())).toBeNull();
  });
});
