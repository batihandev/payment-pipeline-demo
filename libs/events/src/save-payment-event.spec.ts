import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '@testing/db/database';
import { savePaymentEvent } from './save-payment-event';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});

const body = async (paymentId: string) =>
  JSON.parse(
    (await database.db.paymentEvent.findFirstOrThrow({ where: { paymentId } }))
      .body,
  ) as Record<string, unknown>;

// A live event names what was bought, as the list read does, so a stream-only client never shows a blank item.
it('writes the payment with its order and only the card brand and last 4', async () => {
  const customer = await database.db.customer.create({
    data: {
      name: 'Demo customer',
      stripeCustomerId: `cus_${randomUUID()}`,
      stripePaymentMethodId: 'pm_private',
      cardBrand: 'visa',
      cardLast4: '4242',
    },
  });
  const order = await database.db.order.create({
    data: {
      item: 'Tiny victory trumpet',
      price: 650000n,
      expectedAmount: 650000n,
      source: 'visitor',
      rail: 'card',
      customerId: customer.id,
      expiresAt: new Date('2026-10-24T13:00:00Z'),
    },
  });
  const payment = await database.db.payment.create({
    data: {
      provider: 'stripe',
      externalKey: 'pi_event',
      orderId: order.id,
      amount: 650000n,
      stage: 'settled',
    },
  });
  await database.db.$transaction((tx) => savePaymentEvent(tx, payment));
  const event = await body(payment.id);
  expect(event.order).toMatchObject({
    id: order.id,
    item: 'Tiny victory trumpet',
    price: '650000',
    customer: { cardBrand: 'visa', cardLast4: '4242' },
  });
  expect(JSON.stringify(event)).not.toContain('pm_private');
  expect(JSON.stringify(event)).not.toContain('Demo customer');
});

it('writes a payment without an order with a null order', async () => {
  const payment = await database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: `donation-${randomUUID()}`,
      amount: 10000n,
      donation: true,
      stage: 'received',
    },
  });
  await database.db.$transaction((tx) => savePaymentEvent(tx, payment));
  expect((await body(payment.id)).order).toBeNull();
});
