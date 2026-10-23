import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, PrismaClient } from '../../db/src';

type Customer = Awaited<ReturnType<PrismaClient['customer']['findFirst']>>;

type SavedCard = NonNullable<Customer> & {
  stripeCustomerId: string;
  stripePaymentMethodId: string;
};

/** Whether the customer has a saved card that the buyer can charge. */
export function hasSavedCard(customer: Customer): customer is SavedCard {
  return Boolean(customer?.stripeCustomerId && customer.stripePaymentMethodId);
}

@Injectable()
export class CustomersService {
  constructor(@Inject(PrismaService) private readonly db: PrismaClient) {}

  demo(): Promise<Customer> {
    return this.db.customer.findFirst({ orderBy: { createdAt: 'asc' } });
  }
}
