export const receiptNoteKinds = [
  'payment_reorg',
  'settled_reorg',
  'send_reverted',
  'send_dropped',
  'paid_after_expiry',
  'card_failed',
] as const;

export type ReceiptNoteKind = (typeof receiptNoteKinds)[number];
