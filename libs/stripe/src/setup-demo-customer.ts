import type Stripe from 'stripe';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrismaClient } from '@app/db';

type Config = { STRIPE_PAYMENT_METHOD: string; BUYER_PRIVATE_KEY: string };

/** Creates the demo customer and its saved test card; a repeat run changes nothing and a run that failed part-way reuses the card already attached. */
export async function setupDemoCustomer(
  db: PrismaClient,
  stripe: Pick<Stripe, 'customers' | 'paymentMethods'>,
  config: Config,
) {
  let customer =
    (await db.customer.findFirst({ orderBy: { createdAt: 'asc' } })) ??
    (await db.customer.create({ data: { name: 'Demo buyer' } }));

  if (!customer.stripeCustomerId) {
    const created = await stripe.customers.create(
      { name: customer.name },
      { idempotencyKey: `customer-${customer.id}` },
    );
    customer = await db.customer.update({
      where: { id: customer.id },
      data: { stripeCustomerId: created.id },
    });
  }

  if (!customer.stripePaymentMethodId && customer.stripeCustomerId) {
    const saved = await stripe.paymentMethods.list({
      customer: customer.stripeCustomerId,
      type: 'card',
    });
    const method =
      saved.data[0] ??
      (await stripe.paymentMethods.attach(config.STRIPE_PAYMENT_METHOD, {
        customer: customer.stripeCustomerId,
      }));
    await stripe.customers.update(customer.stripeCustomerId, {
      invoice_settings: { default_payment_method: method.id },
    });
    customer = await db.customer.update({
      where: { id: customer.id },
      data: {
        stripePaymentMethodId: method.id,
        cardBrand: method.card?.brand ?? null,
        cardLast4: method.card?.last4 ?? null,
      },
    });
  }

  const chainAddress = privateKeyToAccount(
    config.BUYER_PRIVATE_KEY as `0x${string}`,
  ).address;
  if (customer.chainAddress !== chainAddress)
    customer = await db.customer.update({
      where: { id: customer.id },
      data: { chainAddress },
    });
  return customer;
}
