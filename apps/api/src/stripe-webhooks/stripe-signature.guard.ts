import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { StripeEventVerifier } from '@app/stripe';
import { ApiError } from '../common/api-error';

export type StripeWebhookRequest = RawBodyRequest<Request> & {
  stripeEvent?: Stripe.Event;
};

/** Verifies Stripe's signature over the exact request bytes and keeps the verified event. */
@Injectable()
export class StripeSignatureGuard implements CanActivate {
  constructor(private readonly verifier: StripeEventVerifier) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<StripeWebhookRequest>();
    const signature = request.headers['stripe-signature'];
    if (!request.rawBody || typeof signature !== 'string')
      throw new ApiError(400, 'invalid_signature');
    try {
      request.stripeEvent = this.verifier.verifyEvent(
        request.rawBody,
        signature,
      );
    } catch {
      throw new ApiError(400, 'invalid_signature');
    }
    return true;
  }
}
