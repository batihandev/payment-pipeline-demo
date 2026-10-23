import type Stripe from 'stripe';
import { RpcError } from '../../chain/src/rpc-error';
import type {
  CardPayment,
  CardPaymentInput,
  StripeClient,
} from '../src/stripe-client';

/**
 * A Stripe client that keeps PaymentIntents in memory. A charge returns the same intent for
 * every request with the same order, as Stripe's idempotency key does.
 */
export class FakeStripe implements StripeClient {
  readonly intents = new Map<string, CardPayment>();
  readonly requests: CardPaymentInput[] = [];
  /** What `retrieve` and `search` find, by PaymentIntent id. */
  readonly stored = new Map<string, Stripe.PaymentIntent>();
  readonly lookups: string[] = [];
  /** An error a lookup throws, by PaymentIntent id for `retrieve` and order id for `search`. */
  readonly failures = new Map<string, Error>();
  failure: Error | null = null;
  failAfterAccepting = false;

  createPayment(input: CardPaymentInput): Promise<CardPayment> {
    this.requests.push(input);
    if (this.failure && !this.failAfterAccepting)
      return Promise.reject(this.failure);
    const key = `order-${input.orderId}`;
    const intent = this.intents.get(key) ?? {
      id: `pi_${this.intents.size + 1}`,
      receiptUrl: 'https://pay.stripe.com/receipts/test',
    };
    this.intents.set(key, intent);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(intent);
  }

  retrieve(intentId: string): Promise<Stripe.PaymentIntent> {
    this.lookups.push(intentId);
    const failure = this.failure ?? this.failures.get(intentId);
    if (failure) return Promise.reject(failure);
    const intent = this.stored.get(intentId);
    // Stripe answers 404 resource_missing, which the client maps to a permanent error.
    if (!intent)
      return Promise.reject(new RpcError('permanent', 'resource_missing'));
    return Promise.resolve(intent);
  }

  search(orderId: string): Promise<Stripe.PaymentIntent[]> {
    this.lookups.push(orderId);
    const failure = this.failure ?? this.failures.get(orderId);
    if (failure) return Promise.reject(failure);
    return Promise.resolve(
      [...this.stored.values()].filter(
        (intent) => intent.metadata.orderId === orderId,
      ),
    );
  }
}

/** A PaymentIntent as Stripe returns it, for the fields the card rail reads. */
export function paymentIntent(
  fields: Pick<Stripe.PaymentIntent, 'id' | 'status'> & {
    orderId: string;
    amount?: number;
    receiptUrl?: string | null;
  },
): Stripe.PaymentIntent {
  return {
    id: fields.id,
    object: 'payment_intent',
    status: fields.status,
    amount: fields.amount ?? 50,
    currency: 'usd',
    metadata: { orderId: fields.orderId },
    latest_charge:
      fields.receiptUrl === undefined
        ? 'ch_1'
        : { id: 'ch_1', receipt_url: fields.receiptUrl },
  } as unknown as Stripe.PaymentIntent;
}
