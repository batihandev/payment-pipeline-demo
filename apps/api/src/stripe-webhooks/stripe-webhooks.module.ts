import { Module } from '@nestjs/common';
import { StripeModule } from '../../../../libs/stripe/src';
import { StripeSignatureGuard } from './stripe-signature.guard';
import { StripeWebhooksController } from './stripe-webhooks.controller';
import { StripeWebhooksService } from './stripe-webhooks.service';

@Module({
  imports: [StripeModule],
  controllers: [StripeWebhooksController],
  providers: [StripeWebhooksService, StripeSignatureGuard],
})
export class StripeWebhooksModule {}
