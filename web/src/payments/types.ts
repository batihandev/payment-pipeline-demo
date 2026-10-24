import type {
  DailyStat,
  Health,
  PaymentListItem,
  TodayStats,
} from '@app/core/api';

export type { DailyStat, Health };
export type Stats = TodayStats;
/** A receipt row. An API older than the version column omits `version`. */
export type Payment = Omit<PaymentListItem, 'version'> & { version?: number };
export type Dashboard = {
  /** The newest 100 payments, kept live; the pipeline counts cover these. */
  payments: Payment[];
  /** The receipt window, newest first: 20 at first, growing by 20 with each Show more, up to 200. */
  receipts: Payment[];
  /** Whether Show more can grow the window, is reading it, or has reached the end. */
  olderReceipts: 'more' | 'loading' | 'none';
  /** Whether the last Show more read failed; Show more stays available to try again. */
  olderFailed: boolean;
  stats: Stats;
  daily: DailyStat[];
  /** Null until the first /health read arrives. */
  health: Health | null;
};
export type Snapshot = {
  status: 'loading' | 'live' | 'offline';
  data: Dashboard | null;
};
