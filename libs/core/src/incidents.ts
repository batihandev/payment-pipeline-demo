/** Every kind of incident the services record. The database stores the kind as text. */
export const incidentKinds = [
  'card_failed',
  'cursor_reorg',
  'duplicate',
  'event_failed',
  'gap_progress',
  'gap_recovered',
  'gap_retry_failed',
  'nonce_resynced',
  'notice_failed',
  'paid_after_expiry',
  'payment_reorg',
  'reconcile_failed',
  'refilled',
  'rpc_failed',
  'scan_gap',
  'send_dropped',
  'send_failed',
  'send_reverted',
  'settled_reorg',
  'sweep_failed',
  'swept',
  'tracker_pass_failed',
  'unmatched',
] as const;

export type IncidentKind = (typeof incidentKinds)[number];
