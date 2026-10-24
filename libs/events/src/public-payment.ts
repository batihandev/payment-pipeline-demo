import type { Payment } from '../../db/generated/client';
import type {
  PublicCard,
  PublicOrderRecord,
  PublicPaymentRecord,
} from '@app/core/api';
import { donorName } from '@app/core/donor-name';

/** The order fields a public payment shows: list reads and payment events both select exactly these. */
export const publicOrderSelect = {
  id: true,
  item: true,
  price: true,
  expectedAmount: true,
  status: true,
  source: true,
  createdAt: true,
  expiresAt: true,
  customer: { select: { cardBrand: true, cardLast4: true } },
} as const;

/** The order fields a payment read selects, with the customer when it was included. */
export type OrderRow = Omit<PublicOrderRecord, 'customer'> & {
  customer?: PublicCard | null;
};

function publicOrder(order: OrderRow): PublicOrderRecord {
  return {
    id: order.id,
    item: order.item,
    price: order.price,
    expectedAmount: order.expectedAmount,
    status: order.status,
    source: order.source,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    customer: order.customer
      ? {
          cardBrand: order.customer.cardBrand,
          cardLast4: order.customer.cardLast4,
        }
      : null,
  };
}

/**
 * A payment as the page sees it: no sender address, no PaymentIntent id, no reconciliation
 * time, and of the order's customer only the card brand and last 4. Each field is copied by
 * name, so a new column stays private until it is added here.
 */
export function publicPayment(
  payment: Payment & { order?: OrderRow | null },
): PublicPaymentRecord {
  const { order } = payment;
  return {
    id: payment.id,
    provider: payment.provider,
    ...(payment.provider !== 'stripe' && { externalKey: payment.externalKey }),
    orderId: payment.orderId,
    amount: payment.amount,
    stage: payment.stage,
    confirmations: payment.confirmations,
    chainId: payment.chainId,
    blockNumber: payment.blockNumber,
    blockHash: payment.blockHash,
    transactionHash: payment.transactionHash,
    logIndex: payment.logIndex,
    receiptUrl: payment.receiptUrl,
    donation: payment.donation,
    final: payment.final,
    sentAt: payment.sentAt,
    receivedAt: payment.receivedAt,
    confirmingAt: payment.confirmingAt,
    processingAt: payment.processingAt,
    settledAt: payment.settledAt,
    notifiedAt: payment.notifiedAt,
    finalAt: payment.finalAt,
    version: payment.version,
    donorName:
      payment.donation && payment.fromAddress
        ? donorName(payment.fromAddress)
        : null,
    ...(order !== undefined && { order: order && publicOrder(order) }),
  };
}
