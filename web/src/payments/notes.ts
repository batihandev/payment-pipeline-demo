import type { Incident, Payment } from './types';

const notes: { kinds: string[]; text: string }[] = [
  {
    kinds: ['payment_reorg', 'settled_reorg'],
    text: 'The block with this payment was replaced, so the tracker checked it again.',
  },
  {
    kinds: ['send_reverted', 'send_dropped'],
    text: 'This payment did not go through, so nothing was credited.',
  },
  {
    kinds: ['paid_after_expiry'],
    text: 'Paid after the order expired, and still credited.',
  },
];

export function receiptNote(
  payment: Payment,
  incidents: Incident[],
): string | null {
  const kinds = new Set(
    incidents.filter((i) => i.paymentId === payment.id).map((i) => i.kind),
  );
  const match = notes.find((note) => note.kinds.some((k) => kinds.has(k)));
  if (match) return match.text;
  return payment.donation
    ? 'Thank you for the donation. Only test USDC transfers show here.'
    : null;
}
