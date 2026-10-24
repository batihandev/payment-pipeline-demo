import type { IncidentKind } from './incidents';

export const receiptNoteKinds = [
  'payment_reorg',
  'settled_reorg',
  'send_reverted',
  'send_dropped',
  'paid_after_expiry',
  'card_failed',
] as const satisfies readonly IncidentKind[];

export type ReceiptNoteKind = (typeof receiptNoteKinds)[number];

export function isReceiptNoteKind(kind: string): kind is ReceiptNoteKind {
  return receiptNoteKinds.some((noteKind) => noteKind === kind);
}
