import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomersService, hasSavedCard } from '@app/orders';
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
      // Typed by key: ConfigService's path typing reads an optional key as `undefined`.
      Boolean(
        this.config.get<ApiConfig['STRIPE_WEBHOOK_SECRET']>(
          'STRIPE_WEBHOOK_SECRET',
        ),
      ) && hasSavedCard(await this.customers.demo())
    );
  }
}
