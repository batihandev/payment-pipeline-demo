import type {
  Payment as DatabasePayment,
  Order,
} from '../../../libs/db/generated/client';
import type { ReceiptNoteKind } from '../../../libs/core/src/receipt-notes';

type Json<T> = T extends bigint | Date
  ? string
  : T extends object
    ? { [K in keyof T]: Json<T[K]> }
    : T;
export type Payment = Json<Omit<DatabasePayment, 'fromAddress'>> & {
  donorName: string | null;
  noteKinds: ReceiptNoteKind[];
  order?: Json<Pick<Order, 'id' | 'item' | 'price'>> | null;
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
};
export type Dashboard = {
  payments: Payment[];
  stats: Stats;
  daily: DailyStat[];
  /** Null until the first /health read arrives. */
  health: Health | null;
};
export type Snapshot = {
  status: 'loading' | 'live' | 'offline';
  data: Dashboard | null;
};
