import type { Payment } from '../../db/generated/client';
import { donorName } from '../../core/src/donor-name';
import { bigintReplacer } from '../../core/src/json';
import { publicPayment } from './public-payment';
import { serializePayment } from './publish-payment';

const sender = `0x${'Ab'.repeat(20)}`;
const orderRow = {
  id: 'o1',
  item: 'Duck',
  price: 14000000n,
  expectedAmount: 14000731n,
  status: 'open',
  source: 'visitor',
  createdAt: new Date('2026-10-23T12:00:00Z'),
  expiresAt: new Date('2026-10-23T12:30:00Z'),
} as const;
const payment = (data: Partial<Payment>) =>
  ({
    id: 'p1',
    amount: 14000731n,
    fromAddress: null,
    donation: false,
    ...data,
  }) as Payment;

it('drops the sender and names donations', () => {
  const result = publicPayment(
    payment({ fromAddress: sender.toLowerCase(), donation: true }),
  );
  expect(result).not.toHaveProperty('fromAddress');
  expect(result.donorName).toBe(donorName(sender));
});
it('leaves order payments without a donor name', () => {
  const result = publicPayment(payment({}));
  expect(result).not.toHaveProperty('fromAddress');
  expect(result.donorName).toBeNull();
});
it('keeps the provider and receipt link of a card payment', () => {
  const result = publicPayment(
    payment({
      provider: 'stripe',
      receiptUrl: 'https://pay.stripe.com/receipts/1',
    }),
  );
  expect(result).toMatchObject({
    provider: 'stripe',
    receiptUrl: 'https://pay.stripe.com/receipts/1',
  });
});
it("shows only the card brand and last 4 of the order's customer", () => {
  const customer = {
    id: 'c1',
    name: 'Demo customer',
    chainAddress: sender,
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    cardBrand: 'visa',
    cardLast4: '4242',
    createdAt: new Date(),
  };
  const result = publicPayment({
    ...payment({}),
    order: { ...orderRow, customer },
  });
  expect(result.order).toEqual({
    ...orderRow,
    customer: { cardBrand: 'visa', cardLast4: '4242' },
  });
});
it('leaves an order without a customer with a null customer', () => {
  const result = publicPayment({
    ...payment({}),
    order: { ...orderRow, customer: null },
  });
  expect(result.order).toEqual({ ...orderRow, customer: null });
});
it('copies only the public fields, so a new column stays private', () => {
  const row = { ...payment({}), internalNote: 'private' };
  const order = { ...orderRow, customer: null, signedTransaction: 'private' };
  const shown = publicPayment({ ...row, order });
  expect(JSON.stringify(shown, bigintReplacer)).not.toContain('private');
});
it('omits the PaymentIntent id from a card payment', () => {
  const card = payment({ provider: 'stripe', externalKey: 'pi_secret' });
  expect(publicPayment(card)).not.toHaveProperty('externalKey');
  expect(serializePayment(card)).not.toContain('pi_secret');
  expect(
    publicPayment(payment({ provider: 'chain', externalKey: '84532:0x1:0' })),
  ).toMatchObject({ externalKey: '84532:0x1:0' });
});

it('omits when reconciliation last checked a payment', () => {
  const checked = payment({
    provider: 'stripe',
    reconciledAt: new Date('2026-10-23T12:00:00Z'),
  });
  expect(publicPayment(checked)).not.toHaveProperty('reconciledAt');
  expect(serializePayment(checked)).not.toContain('2026-10-23T12:00:00');
});
