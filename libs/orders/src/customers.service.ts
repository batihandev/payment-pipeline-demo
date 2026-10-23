import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, PrismaClient } from '../../db/src';

type Customer = Awaited<ReturnType<PrismaClient['customer']['findFirst']>>;

/** The one saved card is the signal that the card rail is available. */
export function hasSavedCard(customer: Customer): boolean {
  return Boolean(customer?.stripeCustomerId && customer.stripePaymentMethodId);
}

@Injectable()
export class CustomersService {
  constructor(@Inject(PrismaService) private readonly db: PrismaClient) {}

  demo(): Promise<Customer> {
    return this.db.customer.findFirst({ orderBy: { createdAt: 'asc' } });
  }

  async cardAvailable(): Promise<boolean> {
    return hasSavedCard(await this.demo());
  }
}
