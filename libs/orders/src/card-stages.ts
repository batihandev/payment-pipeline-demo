import type { PaymentStage } from '@app/db';

/** Stages a card payment can leave for `processing`. */
export const BEFORE_PROCESSING: readonly PaymentStage[] = [
  'sent',
  'received',
  'confirming',
];
/** Stages a card payment can leave for `settled` or `failed`; both are terminal. */
export const BEFORE_SETTLED: readonly PaymentStage[] = [
  ...BEFORE_PROCESSING,
  'processing',
];
