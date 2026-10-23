import type { Customer, Payment } from '../../db/generated/client';
import { donorName } from '../../core/src/donor-name';

export type PublicCard = Pick<Customer, 'cardBrand' | 'cardLast4'>;
type OrderWithCustomer = { customer?: PublicCard | null };
export type PublicOrder<O extends OrderWithCustomer> = Omit<O, 'customer'> & {
  customer: PublicCard | null;
};
export type PublicPayment<O extends OrderWithCustomer = OrderWithCustomer> =
  Omit<Payment, 'fromAddress'> & {
    donorName: string | null;
    order?: PublicOrder<O> | null;
  };

function publicOrder<O extends OrderWithCustomer>({
  customer,
  ...order
}: O): PublicOrder<O> {
  return {
    ...order,
    customer: customer
      ? { cardBrand: customer.cardBrand, cardLast4: customer.cardLast4 }
      : null,
  };
}

/** A payment as the page sees it: no sender address, and of the order's customer only the card brand and last 4. */
export function publicPayment<O extends OrderWithCustomer>(
  payment: Payment & { order?: O | null },
): PublicPayment<O> {
  const { fromAddress, order, ...rest } = payment;
  return {
    ...rest,
    donorName: payment.donation && fromAddress ? donorName(fromAddress) : null,
    ...(order !== undefined && { order: order && publicOrder(order) }),
  };
}
