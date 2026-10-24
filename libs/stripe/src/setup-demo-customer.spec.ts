import type Stripe from 'stripe';
import { testDatabase } from '@testing/db/database';
import { setupDemoCustomer } from './setup-demo-customer';

const config = {
  STRIPE_PAYMENT_METHOD: 'pm_card_visa',
  BUYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
};

function fakeStripe() {
  const customersCreate = jest.fn(() => Promise.resolve({ id: 'cus_1' }));
  const attach = jest.fn(() =>
    Promise.resolve({
      id: 'pm_own',
      card: { brand: 'visa', last4: '4242' },
    }),
  );
  const list = jest.fn(() => Promise.resolve({ data: [] as unknown[] }));
  const update = jest.fn(() => Promise.resolve({}));
  return {
    stripe: {
      customers: { create: customersCreate, update },
      paymentMethods: { attach, list },
    } as unknown as Stripe,
    customersCreate,
    attach,
    list,
    update,
  };
}

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.db.customer.deleteMany();
});

it('creates the customer and saved card once', async () => {
  const { db } = database;
  const { stripe, customersCreate, attach, update } = fakeStripe();
  const first = await setupDemoCustomer(db, stripe, config);
  expect(first).toMatchObject({
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_own',
    cardBrand: 'visa',
    cardLast4: '4242',
  });
  expect(first.chainAddress).toBe('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
  expect(attach).toHaveBeenCalledWith('pm_card_visa', { customer: 'cus_1' });
  expect(update).toHaveBeenCalledWith('cus_1', {
    invoice_settings: { default_payment_method: 'pm_own' },
  });

  const second = await setupDemoCustomer(db, stripe, config);
  expect(second).toEqual(first);
  expect(await db.customer.count()).toBe(1);
  expect(customersCreate).toHaveBeenCalledTimes(1);
  expect(attach).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
});

it('finishes a customer whose card was not saved', async () => {
  const { db } = database;
  await db.customer.create({
    data: { name: 'Demo buyer', stripeCustomerId: 'cus_existing' },
  });
  const { stripe, customersCreate, attach } = fakeStripe();
  const result = await setupDemoCustomer(db, stripe, config);
  expect(customersCreate).not.toHaveBeenCalled();
  expect(attach).toHaveBeenCalledWith('pm_card_visa', {
    customer: 'cus_existing',
  });
  expect(result.stripePaymentMethodId).toBe('pm_own');
  expect(await db.customer.count()).toBe(1);
});

it('creates the customer with a key derived from the local row', async () => {
  const { db } = database;
  const { stripe, customersCreate } = fakeStripe();
  const result = await setupDemoCustomer(db, stripe, config);
  expect(customersCreate).toHaveBeenCalledWith(
    { name: 'Demo buyer' },
    { idempotencyKey: `customer-${result.id}` },
  );
});

it('reuses the attached card after a failed run', async () => {
  const { db } = database;
  const { stripe, attach, list, update } = fakeStripe();
  const attached = { id: 'pm_own', card: { brand: 'visa', last4: '4242' } };
  update.mockRejectedValueOnce(new Error('network'));
  attach.mockImplementation(() => {
    list.mockResolvedValue({ data: [attached] });
    return Promise.resolve(attached);
  });

  await expect(setupDemoCustomer(db, stripe, config)).rejects.toThrow(
    'network',
  );
  const result = await setupDemoCustomer(db, stripe, config);

  expect(list).toHaveBeenLastCalledWith({ customer: 'cus_1', type: 'card' });
  expect(attach).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    stripePaymentMethodId: 'pm_own',
    cardBrand: 'visa',
    cardLast4: '4242',
  });
});
