import Stripe from 'stripe';
import { RpcError } from '../../chain/src/rpc-error';
import type { RpcLimiter } from '../../chain/src/rpc-limiter';

export type CardPayment = {
  id: string;
  status: string;
  receiptUrl: string | null;
};

export type CardPaymentInput = {
  amountCents: number;
  customer: string;
  paymentMethod: string;
  orderId: string;
};

export class CardDeclinedError extends Error {
  constructor(
    readonly declineCode: string | null,
    readonly intentId: string | null,
  ) {
    super('Card payment declined');
  }
}

export abstract class StripeClient {
  abstract createPayment(input: CardPaymentInput): Promise<CardPayment>;
}

function classifyStripeError(error: unknown): RpcError | CardDeclinedError {
  if (error instanceof RpcError) return error;
  if (error instanceof Stripe.errors.StripeCardError)
    return new CardDeclinedError(
      error.decline_code ?? error.code ?? null,
      error.payment_intent?.id ?? null,
    );
  if (error instanceof Stripe.errors.StripeRateLimitError)
    return new RpcError('rate_limit');
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeIdempotencyError ||
    (error instanceof Stripe.errors.StripeError &&
      error.statusCode !== undefined &&
      (error.statusCode >= 500 || error.statusCode === 409))
  )
    return new RpcError('transient');
  return new RpcError('permanent');
}

export class SdkStripeClient implements StripeClient {
  constructor(
    private readonly stripe: Stripe | undefined,
    private readonly limiter: RpcLimiter,
  ) {}

  async createPayment(input: CardPaymentInput): Promise<CardPayment> {
    const stripe = this.stripe;
    if (!stripe)
      throw new RpcError('permanent', 'STRIPE_SECRET_KEY is not set');
    const intent = await this.call(() =>
      stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: 'usd',
          customer: input.customer,
          payment_method: input.paymentMethod,
          confirm: true,
          off_session: true,
          metadata: { orderId: input.orderId },
          expand: ['latest_charge'],
        },
        { idempotencyKey: `order-${input.orderId}` },
      ),
    );
    const charge = intent.latest_charge;
    return {
      id: intent.id,
      status: intent.status,
      receiptUrl:
        typeof charge === 'object' && charge ? charge.receipt_url : null,
    };
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.limiter.run(async () => {
        try {
          return await operation();
        } catch (error) {
          throw classifyStripeError(error);
        }
      });
    } catch (error) {
      // The limiter has started the cooldown; callers retry the send like any transient failure.
      if (error instanceof RpcError && error.kind === 'rate_limit')
        throw new RpcError('transient');
      throw error;
    }
  }
}
