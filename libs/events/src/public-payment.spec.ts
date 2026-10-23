import type { Payment } from '../../db/generated/client';
import { donorName } from '../../core/src/donor-name';
import { publicPayment } from './public-payment';

const sender = `0x${'Ab'.repeat(20)}`;
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
    order: { id: 'o1', item: 'Duck', customer },
  });
  expect(result.order).toEqual({
    id: 'o1',
    item: 'Duck',
    customer: { cardBrand: 'visa', cardLast4: '4242' },
  });
});
it('leaves an order without a customer with a null customer', () => {
  const result = publicPayment({
    ...payment({}),
    order: { id: 'o1', customer: null },
  });
  expect(result.order).toEqual({ id: 'o1', customer: null });
});
