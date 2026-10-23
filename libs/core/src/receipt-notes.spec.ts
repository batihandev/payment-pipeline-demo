import { receiptNoteKinds } from './receipt-notes';

it('lists the incident kinds a receipt note can explain', () => {
  expect(receiptNoteKinds).toEqual([
    'payment_reorg',
    'settled_reorg',
    'send_reverted',
    'send_dropped',
    'paid_after_expiry',
    'card_failed',
  ]);
});
