import type { Payment } from '../../db/generated/client';
import { donorName } from '../../core/src/donor-name';

export type PublicPayment = Omit<Payment, 'fromAddress'> & {
  donorName: string | null;
};

export function publicPayment(payment: Payment): PublicPayment {
  const { fromAddress, ...rest } = payment;
  return {
    ...rest,
    donorName: payment.donation && fromAddress ? donorName(fromAddress) : null,
  };
}
