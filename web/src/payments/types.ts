import type {
  Customer,
  Payment as DatabasePayment,
  Order,
} from '../../../libs/db/generated/client';
import type { ReceiptNoteKind } from '../../../libs/core/src/receipt-notes';

type Json<T> = T extends bigint | Date
  ? string
  : T extends object
    ? { [K in keyof T]: Json<T[K]> }
    : T;
export type Payment = Json<
  Omit<
    DatabasePayment,
    'fromAddress' | 'externalKey' | 'reconciledAt' | 'version'
  >
> & {
  /** Rises with every update to the row. An API older than the version column omits it. */
  version?: number;
  /** Set for chain payments only; a card payment's PaymentIntent id stays private. */
  externalKey?: string;
  donorName: string | null;
  noteKinds: ReceiptNoteKind[];
  order?:
    | (Json<Pick<Order, 'id' | 'item' | 'price'>> & {
        customer?: Pick<Customer, 'cardBrand' | 'cardLast4'> | null;
      })
    | null;
  explorerUrl?: string | null;
};
export type Stats = {
  settledCount: number;
  averageTimeToSettleMs: number | null;
  duplicatesSkipped: number;
  failuresRecovered: number;
};
export type DailyStat = {
  day: string;
  settled: number;
  scheduled: number;
  visitor: number;
  averageTimeToSettleMs: number | null;
};
export type Health = {
  confirmations: number;
  head: string | null;
  cursor: string | null;
  lag: string | null;
  openGaps: number;
  queueDepth: Record<string, number> | null;
  cooldowns: Record<string, number> | null;
  balances: Record<
    string,
    { native: string; usdc: string; lowNative: boolean; lowUsdc: boolean }
  > | null;
  chainError: string | null;
  cardAvailable: boolean;
};
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
