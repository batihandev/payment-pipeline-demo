import { z } from 'zod';
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
const integer = z.string().regex(/^-?\d+$/);
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
  customer: z
    .object({
      cardBrand: z.string().nullable(),
      cardLast4: z.string().nullable(),
    })
    .nullable(),
}) satisfies z.ZodType<NonNullable<Payment['order']>>;

/** A payment on the event stream. An API older than the version column omits `version`. */
export const paymentEvent = z.object({
  id: z.string(),
  provider: z.enum(paymentProviders),
  externalKey: z.string().optional(),
  orderId: z.string().nullable(),
  amount: integer,
  stage: z.enum(paymentStages),
  confirmations: z.number(),
  chainId: z.number().nullable(),
  blockNumber: integer.nullable(),
  blockHash: z.string().nullable(),
  transactionHash: z.string().nullable(),
  logIndex: z.number().nullable(),
  receiptUrl: z.string().nullable(),
  donation: z.boolean(),
  final: z.boolean(),
  sentAt: time.nullable(),
  receivedAt: time.nullable(),
  confirmingAt: time.nullable(),
  processingAt: time.nullable(),
  settledAt: time.nullable(),
  notifiedAt: time.nullable(),
  finalAt: time.nullable(),
  version: z.number().optional(),
  donorName: z.string().nullable(),
  order: order.nullable().optional(),
}) satisfies z.ZodType<Omit<Payment, 'noteKinds' | 'explorerUrl'>>;
export type PaymentEvent = z.output<typeof paymentEvent>;

/** `GET /payments`. A note kind this page does not know is left out rather than refused. */
export const paymentList = z.array(
  paymentEvent.extend({
    noteKinds: z
      .array(z.string())
      .transform((kinds) => kinds.filter(isReceiptNoteKind)),
    explorerUrl: z.string().nullable(),
  }),
) satisfies z.ZodType<Payment[]>;

export const todayStats = z.object({
  settledCount: z.number(),
  averageTimeToSettleMs: z.number().nullable(),
  duplicatesSkipped: z.number(),
  failuresRecovered: z.number(),
}) satisfies z.ZodType<Stats>;

export const dailyStats = z.array(
  z.object({
    day: z.string(),
    settled: z.number(),
    scheduled: z.number(),
    visitor: z.number(),
    averageTimeToSettleMs: z.number().nullable(),
  }),
) satisfies z.ZodType<DailyStat[]>;

const balance = z.object({
  native: integer,
  usdc: integer,
  lowNative: z.boolean(),
  lowUsdc: z.boolean(),
});
const counts = z.record(z.string(), z.number()).nullable();

export const health = z.object({
  confirmations: z.number(),
  head: integer.nullable(),
  cursor: integer.nullable(),
  lag: integer.nullable(),
  openGaps: z.number(),
  queueDepth: counts,
  cooldowns: counts,
  balances: z.object({ buyer: balance, shop: balance }).nullable(),
  chainError: z.string().nullable(),
  cardAvailable: z.boolean(),
  redisError: z.literal('unavailable').nullable(),
  monitoring: z.object({
    cursorAdvancedAt: time.nullable(),
    oldestUnsettledAt: time.nullable(),
    oldestUnnotifiedAt: time.nullable(),
    lastScheduledPurchaseAt: time.nullable(),
    visitorPausedSince: time.nullable(),
  }),
}) satisfies z.ZodType<Health>;

/** `POST /test-purchases`: an accepted order, or a refusal that may still carry the order. */
export const purchaseBody = z.object({
  orderId: z.string().optional(),
  position: z.number().optional(),
  item: z.string().optional(),
  price: integer.optional(),
  expiresAt: time.optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<Partial<PurchaseAccepted> & Partial<ApiRefusal>>;
export type PurchaseBody = z.output<typeof purchaseBody>;

export const orderPosition = z.object({
  position: z.number(),
  closed: z.boolean(),
}) satisfies z.ZodType<OrderPosition>;

export const orderEvent = z.object({
  type: z.literal('order'),
  id: z.string(),
  closed: z.boolean(),
}) satisfies z.ZodType<OrderEvent>;

export const queueEvent = z.object({
  type: z.literal('queue'),
  waiting: z.array(z.string()),
}) satisfies z.ZodType<QueueEvent>;

/** An order or queue event on the stream, told apart by its `type`. */
export const orderUpdate = z.discriminatedUnion('type', [
  orderEvent,
  queueEvent,
]);
