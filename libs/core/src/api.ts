import type { ReceiptNoteKind } from './receipt-notes';

/**
 * The API's public responses. Each record type is what a route or event builds, with bigints and
 * dates; `Json<T>` is the same value as the page receives it, after the API's JSON replacer turns
 * bigints and dates into strings.
 */
export type Json<T> = T extends bigint | Date
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;

export const paymentProviders = ['chain', 'stripe'] as const;
export type PaymentProvider = (typeof paymentProviders)[number];
export const paymentStages = [
  'sent',
  'received',
  'confirming',
  'processing',
  'settled',
  'notified',
  'failed',
] as const;
export type PaymentStage = (typeof paymentStages)[number];
export const orderStatuses = ['open', 'paid', 'expired'] as const;
export type OrderStatus = (typeof orderStatuses)[number];
export const orderSources = ['schedule', 'visitor'] as const;
export type OrderSource = (typeof orderSources)[number];

/** Of a card payment's customer, only the card brand and last 4 are public. */
export type PublicCard = { cardBrand: string | null; cardLast4: string | null };

export type PublicOrderRecord = {
  id: string;
  item: string;
  price: bigint;
  expectedAmount: bigint;
  status: OrderStatus;
  source: OrderSource;
  createdAt: Date;
  expiresAt: Date;
  customer: PublicCard | null;
};

/** A payment as the page sees it, on the event stream and in `GET /payments`. */
export type PublicPaymentRecord = {
  id: string;
  provider: PaymentProvider;
  /** Set for chain payments only; a card payment's PaymentIntent id stays private. */
  externalKey?: string;
  orderId: string | null;
  amount: bigint;
  stage: PaymentStage;
  confirmations: number;
  chainId: number | null;
  blockNumber: bigint | null;
  blockHash: string | null;
  transactionHash: string | null;
  logIndex: number | null;
  receiptUrl: string | null;
  donation: boolean;
  final: boolean;
  sentAt: Date | null;
  receivedAt: Date | null;
  confirmingAt: Date | null;
  processingAt: Date | null;
  settledAt: Date | null;
  notifiedAt: Date | null;
  finalAt: Date | null;
  /** Rises with every update to the row, so a reader can tell which of two copies is newer. */
  version: number;
  donorName: string | null;
  /** Present when the read included the order. */
  order?: PublicOrderRecord | null;
};
export type PublicPayment = Json<PublicPaymentRecord>;

/** One row of `GET /payments`: the payment with its receipt notes and explorer link. */
export type PaymentListItemRecord = PublicPaymentRecord & {
  noteKinds: ReceiptNoteKind[];
  explorerUrl: string | null;
};
export type PaymentListItem = Json<PaymentListItemRecord>;

/** `GET /stats`: today's figures, UTC. */
export type TodayStats = {
  settledCount: number;
  averageTimeToSettleMs: number | null;
  duplicatesSkipped: number;
  failuresRecovered: number;
};

/** One day of `GET /stats/daily`. */
export type DailyStat = {
  day: string;
  settled: number;
  scheduled: number;
  visitor: number;
  averageTimeToSettleMs: number | null;
};

export type BalanceReport = {
  native: bigint;
  usdc: bigint;
  lowNative: boolean;
  lowUsdc: boolean;
};

/** `GET /health`. Redis parts are null while Redis is down, chain parts while the chain read fails. */
export type HealthRecord = {
  confirmations: number;
  head: bigint | null;
  cursor: bigint | null;
  lag: bigint | null;
  openGaps: number;
  queueDepth: Record<string, number> | null;
  cooldowns: Record<string, number> | null;
  balances: { buyer: BalanceReport; shop: BalanceReport } | null;
  chainError: string | null;
  cardAvailable: boolean;
  redisError: 'unavailable' | null;
  monitoring: {
    cursorAdvancedAt: Date | null;
    oldestUnsettledAt: Date | null;
    oldestUnnotifiedAt: Date | null;
    lastScheduledPurchaseAt: Date | null;
    visitorPausedSince: string | null;
  };
};
export type Health = Json<HealthRecord>;

/** `POST /test-purchases` when the order is accepted. */
export type PurchaseAccepted = {
  orderId: string;
  position: number;
  item: string;
  price: string;
  /** When the order expires, as an ISO timestamp. */
  expiresAt: string;
};

/**
 * A refused request: a fixed code. A purchase that was accepted but could not be queued also
 * carries the order, so the page can follow it.
 */
export type ApiRefusal = { error: string } & Partial<
  Omit<PurchaseAccepted, 'position'>
>;

/** `GET /test-purchases/:id`: the order's place in the queue, and whether it closed unsent. */
export type OrderPosition = { position: number; closed: boolean };

/** Event stream: an order changed; `closed` means it closed without a payment being sent. */
export type OrderEvent = { type: 'order'; id: string; closed: boolean };
/** Event stream: the visitor orders waiting to be sent, oldest first. */
export type QueueEvent = { type: 'queue'; waiting: string[] };
