import type { ReceiptNoteKind } from '../../../libs/core/src/receipt-notes';
import type { Payment } from './types';

const failureKinds: ReceiptNoteKind[] = [
  'send_reverted',
  'send_dropped',
  'card_failed',
];
export const failedNote =
  'This payment did not go through, so nothing was credited.';

const notes: { kinds: ReceiptNoteKind[]; text: string }[] = [
  {
    kinds: ['payment_reorg', 'settled_reorg'],
    text: 'The block with this payment was replaced, so the tracker checked it again.',
  },
  { kinds: failureKinds, text: failedNote },
  {
    kinds: ['paid_after_expiry'],
    text: 'Paid after the order expired, and still credited.',
  },
];

export function didNotGoThrough(payment: Pick<Payment, 'noteKinds'>): boolean {
  return failureKinds.some((kind) => payment.noteKinds.includes(kind));
}

export function receiptNote(payment: Payment): string | null {
  const match = notes.find((note) =>
    note.kinds.some((kind) => payment.noteKinds.includes(kind)),
  );
  if (match) return match.text;
  return payment.donation
    ? 'Thank you for the donation. Only test USDC transfers show here.'
    : null;
}
