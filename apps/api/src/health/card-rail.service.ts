import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomersService, hasSavedCard } from '../../../../libs/orders/src';
import type { ApiConfig } from '../common/api-config';

/**
 * The card rail is offered only when the demo customer has a saved card and the API can verify
 * Stripe webhooks, since the webhook is what settles a card payment.
 */
@Injectable()
export class CardRailService {
  constructor(
    private readonly customers: CustomersService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  async available(): Promise<boolean> {
    return (
      Boolean(this.config.get('STRIPE_WEBHOOK_SECRET', { infer: true })) &&
      hasSavedCard(await this.customers.demo())
    );
  }
}
