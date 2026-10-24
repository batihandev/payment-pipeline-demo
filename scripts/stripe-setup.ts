import { PrismaPg } from '@prisma/adapter-pg';
import Stripe from 'stripe';
import {
  ConfigError,
  buyerSchema,
  stripeSetupSchema,
  validateConfig,
} from '@app/config';
import { PrismaClient } from '@app/db';
import { setupDemoCustomer } from '@app/stripe/setup-demo-customer';

const setupSchema = stripeSetupSchema.extend(
  buyerSchema.pick({ DATABASE_URL: true, BUYER_PRIVATE_KEY: true }).shape,
);

async function main(): Promise<void> {
  const config = validateConfig(setupSchema, process.env);
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
  });
  try {
    const customer = await setupDemoCustomer(
      db,
      new Stripe(config.STRIPE_SECRET_KEY),
      config,
    );
    const brand = customer.cardBrand
      ? customer.cardBrand.charAt(0).toUpperCase() + customer.cardBrand.slice(1)
      : 'Card';
    console.log(
      `Customer: ${customer.stripeCustomerId}\nPayment method: ${customer.stripePaymentMethodId}\n${brand} ····${customer.cardLast4}`,
    );
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof ConfigError
        ? error.message
        : 'Could not set up the demo customer. Check the Stripe test key and database settings.',
    );
    process.exitCode = 1;
  });
}
