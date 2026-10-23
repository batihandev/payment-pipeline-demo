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
