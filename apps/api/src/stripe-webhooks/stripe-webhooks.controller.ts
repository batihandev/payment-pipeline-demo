import { Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  StripeSignatureGuard,
  type StripeWebhookRequest,
} from './stripe-signature.guard';
import { StripeWebhooksService } from './stripe-webhooks.service';

@Controller('stripe/webhooks')
export class StripeWebhooksController {
  constructor(private readonly webhooks: StripeWebhooksService) {}

  @Post()
  @SkipThrottle()
  @HttpCode(200)
  @UseGuards(StripeSignatureGuard)
  async accept(
    @Req() request: StripeWebhookRequest,
  ): Promise<{ received: true }> {
    if (request.stripeEvent) await this.webhooks.handle(request.stripeEvent);
    return { received: true };
  }
}
