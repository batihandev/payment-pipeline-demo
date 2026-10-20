import type {
  Payment as DatabasePayment,
  Order,
  Incident as DatabaseIncident,
} from '../../../libs/db/generated/client';

type Json<T> = T extends bigint | Date
  ? string
  : T extends object
    ? { [K in keyof T]: Json<T[K]> }
    : T;
export type Payment = Json<DatabasePayment> & {
  order?: Json<Pick<Order, 'id' | 'item' | 'price'>> | null;
  explorerUrl?: string | null;
};
export type Incident = Json<DatabaseIncident>;
export type Stats = {
  settledCount: number;
  averageTimeToSettleMs: number | null;
  duplicatesSkipped: number;
  failuresRecovered: number;
};
export type Health = {
  confirmations: number;
  head: string;
  cursor: string | null;
  lag: string | null;
  openGaps: number;
  queueDepth: Record<string, number>;
  cooldowns: Record<string, number>;
  balances: Record<
    string,
    { native: string; usdc: string; lowNative: boolean; lowUsdc: boolean }
  >;
};
export type Dashboard = {
  payments: Payment[];
  stats: Stats;
  health: Health;
  incidents: Incident[];
};
export type Snapshot = {
  status: 'loading' | 'live' | 'offline';
  data: Dashboard | null;
};
