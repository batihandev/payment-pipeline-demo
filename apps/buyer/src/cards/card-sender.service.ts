import { Injectable } from '@nestjs/common';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { PrismaService, type Prisma } from '../../../../libs/db/src';
import { closeOrder } from '../../../../libs/orders/src/close-order';
import { CustomersService } from '../../../../libs/orders/src';
import {
  CardDeclinedError,
  StripeClient,
  type CardPayment,
} from '../../../../libs/stripe/src';

const CENTS = 10000n;
const BEFORE_PROCESSING = ['sent', 'received', 'confirming'] as const;

@Injectable()
export class CardSenderService {
  constructor(
    private readonly db: PrismaService,
    private readonly stripe: StripeClient,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Charges the demo customer's saved card for a pending card order. Stripe returns the same
   * PaymentIntent for every retry of an order, so a retry after a timeout never charges twice.
   * Settlement is written by the webhook; this only records that the charge was accepted.
   */
  async charge(orderId: string, exhausted: boolean): Promise<void> {
    const order = await this.claim(orderId);
    if (!order) return;
    try {
      const customer = await this.customers.demo();
      if (!customer?.stripeCustomerId || !customer.stripePaymentMethodId)
        throw new RpcError('permanent', 'no saved card');
      const payment = await this.stripe.createPayment({
        amountCents: Number(order.price / CENTS),
        customer: customer.stripeCustomerId,
        paymentMethod: customer.stripePaymentMethodId,
        orderId,
      });
      await this.record(orderId, order.expectedAmount, payment);
    } catch (error) {
      if (error instanceof CardDeclinedError) await this.decline(orderId);
      else {
        await this.recordFailure(orderId, error, exhausted);
        throw error instanceof RpcError ? error : new RpcError('transient');
      }
    }
  }

  private async lockOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  }

  /** Returns the order when it is pending and open; closes an expired unsent one. */
  private claim(orderId: string) {
    return this.db.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      if (order.sendState !== 'pending') return null;
      if (order.status === 'expired') {
        await closeOrder(tx, order);
        return null;
      }
      await tx.order.update({
        where: { id: orderId },
        data: { sendAttempts: { increment: 1 } },
      });
      return order;
    });
  }

  private record(orderId: string, amount: bigint, payment: CardPayment) {
    return this.db.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const now = new Date();
      const where = {
        provider_externalKey: { provider: 'stripe', externalKey: payment.id },
      } as const;
      await tx.payment.upsert({
        where,
        create: {
          provider: 'stripe',
          externalKey: payment.id,
          orderId,
          amount,
          stage: 'processing',
          sentAt: now,
          processingAt: now,
          receiptUrl: payment.receiptUrl,
        },
        update: { orderId, sentAt: now, receiptUrl: payment.receiptUrl },
      });
      // The webhook may already have settled the payment; a stage never moves backwards.
      await tx.payment.updateMany({
        where: {
          provider: 'stripe',
          externalKey: payment.id,
          stage: { in: [...BEFORE_PROCESSING] },
        },
        data: { stage: 'processing', processingAt: now },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { sendState: 'sent' },
      });
    });
  }

  private decline(orderId: string) {
    return this.db.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      if (order.sendState !== 'pending') return;
      await closeOrder(tx, order);
      await tx.incident.create({
        data: {
          kind: 'card_failed',
          whatHappened: 'The test card was declined.',
          howHandled: 'Closed the order; nothing was credited.',
        },
      });
    });
  }

  private recordFailure(orderId: string, error: unknown, exhausted: boolean) {
    const kind = error instanceof RpcError ? error.kind : 'transient';
    return this.db.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      const closed = kind === 'permanent' && order.sendState === 'pending';
      if (closed) await closeOrder(tx, order);
      else if (exhausted && order.sendState === 'pending')
        await tx.order.update({
          where: { id: orderId },
          data: { sendState: 'review' },
        });
      await tx.incident.create({
        data: {
          kind: 'send_failed',
          whatHappened: `Card payment ${orderId} failed (${kind}).`,
          howHandled: closed
            ? 'No charge was made; released the reservation and closed the order.'
            : exhausted
              ? 'Automatic retries stopped; kept the reservation for manual review.'
              : 'Kept the reservation; retry with backoff.',
        },
      });
    });
  }
}
