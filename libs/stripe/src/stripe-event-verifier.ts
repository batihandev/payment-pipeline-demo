import Stripe from 'stripe';

export abstract class StripeEventVerifier {
  abstract verifyEvent(rawBody: Buffer, signature: string): Stripe.Event;
}

export class SdkStripeEventVerifier implements StripeEventVerifier {
  constructor(private readonly webhookSecret: string | undefined) {}

  verifyEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!this.webhookSecret)
      throw new Error('Stripe webhook secret is not configured');
    return Stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
  }
}
