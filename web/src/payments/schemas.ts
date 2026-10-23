import { z } from 'zod/mini';
import {
  orderSources,
  orderStatuses,
  paymentProviders,
  paymentStages,
  type ApiRefusal,
  type OrderEvent,
  type OrderPosition,
  type PurchaseAccepted,
  type QueueEvent,
} from '../../../libs/core/src/api';
import { isReceiptNoteKind } from '../../../libs/core/src/receipt-notes';
import type { DailyStat, Health, Payment, Stats } from './types';

/**
 * One schema per API response, each checked against the libs/core type it reads, so a body
 * that does not match is refused at the client instead of reaching the page.
 */
const integer = z.string().check(z.regex(/^-?\d+$/));
const time = z.string();

const order = z.object({
  id: z.string(),
  item: z.string(),
  price: integer,
  expectedAmount: integer,
  status: z.enum(orderStatuses),
  source: z.enum(orderSources),
  createdAt: time,
  expiresAt: time,
  customer: z.nullable(
    z.object({
      cardBrand: z.nullable(z.string()),
      cardLast4: z.nullable(z.string()),
    }),
  ),
}) satisfies z.ZodMiniType<NonNullable<Payment['order']>>;

/** A payment on the event stream. An API older than the version column omits `version`. */
export const paymentEvent = z.object({
  id: z.string(),
  provider: z.enum(paymentProviders),
  externalKey: z.optional(z.string()),
  orderId: z.nullable(z.string()),
  amount: integer,
  stage: z.enum(paymentStages),
  confirmations: z.number(),
  chainId: z.nullable(z.number()),
  blockNumber: z.nullable(integer),
  blockHash: z.nullable(z.string()),
  transactionHash: z.nullable(z.string()),
  logIndex: z.nullable(z.number()),
  receiptUrl: z.nullable(z.string()),
  donation: z.boolean(),
  final: z.boolean(),
  sentAt: z.nullable(time),
  receivedAt: z.nullable(time),
  confirmingAt: z.nullable(time),
  processingAt: z.nullable(time),
  settledAt: z.nullable(time),
  notifiedAt: z.nullable(time),
  finalAt: z.nullable(time),
  version: z.optional(z.number()),
  donorName: z.nullable(z.string()),
  order: z.optional(z.nullable(order)),
}) satisfies z.ZodMiniType<Omit<Payment, 'noteKinds' | 'explorerUrl'>>;
export type PaymentEvent = z.output<typeof paymentEvent>;

/** `GET /payments`. A note kind this page does not know is left out rather than refused. */
export const paymentList = z.array(
  z.extend(paymentEvent, {
    noteKinds: z.pipe(
      z.array(z.string()),
      z.transform((kinds) => kinds.filter(isReceiptNoteKind)),
    ),
    explorerUrl: z.nullable(z.string()),
  }),
) satisfies z.ZodMiniType<Payment[]>;

export const todayStats = z.object({
  settledCount: z.number(),
  averageTimeToSettleMs: z.nullable(z.number()),
  duplicatesSkipped: z.number(),
  failuresRecovered: z.number(),
}) satisfies z.ZodMiniType<Stats>;

export const dailyStats = z.array(
  z.object({
    day: z.string(),
    settled: z.number(),
    scheduled: z.number(),
    visitor: z.number(),
    averageTimeToSettleMs: z.nullable(z.number()),
  }),
) satisfies z.ZodMiniType<DailyStat[]>;

const balance = z.object({
  native: integer,
  usdc: integer,
  lowNative: z.boolean(),
  lowUsdc: z.boolean(),
});
const counts = z.nullable(z.record(z.string(), z.number()));

export const health = z.object({
  confirmations: z.number(),
  head: z.nullable(integer),
  cursor: z.nullable(integer),
  lag: z.nullable(integer),
  openGaps: z.number(),
  queueDepth: counts,
  cooldowns: counts,
  balances: z.nullable(z.object({ buyer: balance, shop: balance })),
  chainError: z.nullable(z.string()),
  cardAvailable: z.boolean(),
  redisError: z.nullable(z.literal('unavailable')),
  monitoring: z.object({
    cursorAdvancedAt: z.nullable(time),
    oldestUnsettledAt: z.nullable(time),
    oldestUnnotifiedAt: z.nullable(time),
    lastScheduledPurchaseAt: z.nullable(time),
    visitorPausedSince: z.nullable(time),
  }),
}) satisfies z.ZodMiniType<Health>;

/** `POST /test-purchases`: an accepted order, or a refusal that may still carry the order. */
export const purchaseBody = z.object({
  orderId: z.optional(z.string()),
  position: z.optional(z.number()),
  item: z.optional(z.string()),
  price: z.optional(integer),
  expiresAt: z.optional(time),
  error: z.optional(z.string()),
}) satisfies z.ZodMiniType<Partial<PurchaseAccepted> & Partial<ApiRefusal>>;
export type PurchaseBody = z.output<typeof purchaseBody>;

export const orderPosition = z.object({
  position: z.number(),
  closed: z.boolean(),
}) satisfies z.ZodMiniType<OrderPosition>;

export const orderEvent = z.object({
  type: z.literal('order'),
  id: z.string(),
  closed: z.boolean(),
}) satisfies z.ZodMiniType<OrderEvent>;

export const queueEvent = z.object({
  type: z.literal('queue'),
  waiting: z.array(z.string()),
}) satisfies z.ZodMiniType<QueueEvent>;

/** An order or queue event on the stream, told apart by its `type`. */
export const orderUpdate = z.discriminatedUnion('type', [
  orderEvent,
  queueEvent,
]);
