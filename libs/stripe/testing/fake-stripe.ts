import type Stripe from 'stripe';
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
  failure: Error | null = null;
  failAfterAccepting = false;

  async createPayment(input: CardPaymentInput): Promise<CardPayment> {
    this.requests.push(input);
    if (this.failure && !this.failAfterAccepting) throw this.failure;
    const key = `order-${input.orderId}`;
    const intent = this.intents.get(key) ?? {
      id: `pi_${this.intents.size + 1}`,
      receiptUrl: 'https://pay.stripe.com/receipts/test',
    };
    this.intents.set(key, intent);
    if (this.failure) throw this.failure;
    return intent;
  }

  async retrieve(intentId: string): Promise<Stripe.PaymentIntent> {
    this.lookups.push(intentId);
    if (this.failure) throw this.failure;
    const intent = this.stored.get(intentId);
    if (!intent) throw new Error(`No such PaymentIntent: ${intentId}`);
    return intent;
  }

  async search(orderId: string): Promise<Stripe.PaymentIntent[]> {
    this.lookups.push(orderId);
    if (this.failure) throw this.failure;
    return [...this.stored.values()].filter(
      (intent) => intent.metadata.orderId === orderId,
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
