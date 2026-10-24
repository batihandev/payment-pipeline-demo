import { expect, it, vi, type Mock } from 'vitest';
import Stripe from 'stripe';
import { RpcError } from '@app/chain/rpc-error';
import { RpcLimiter } from '@app/chain/rpc-limiter';
import {
  CardDeclinedError,
  SdkStripeClient,
  StripeAccessError,
} from './stripe-client';

const input = {
  amountCents: 52,
  customer: 'cus_1',
  paymentMethod: 'pm_1',
  orderId: 'order-1',
};

function fakeStripe(create: Mock) {
  return { paymentIntents: { create } } as unknown as Stripe;
}

function limiterWith(reportCooldown = vi.fn(() => Promise.resolve(undefined))) {
  return {
    reportCooldown,
    limiter: new RpcLimiter(
      1000,
      1000,
      Date.now,
      () => Promise.resolve(undefined),
      reportCooldown,
    ),
  };
}

const intent = {
  id: 'pi_1',
  status: 'processing',
  latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/1' },
};

it('sends the same idempotency key on a retry', async () => {
  const create = vi.fn(() => Promise.resolve(intent));
  const client = new SdkStripeClient(fakeStripe(create), limiterWith().limiter);
  const first = await client.createPayment(input);
  const retry = await client.createPayment(input);
  expect(first).toEqual({
    id: 'pi_1',
    receiptUrl: 'https://pay.stripe.com/receipts/1',
  });
  expect(retry).toEqual(first);
  expect(create).toHaveBeenCalledTimes(2);
  for (const [params, options] of create.mock.calls as unknown as [
    unknown,
    unknown,
  ][]) {
    expect(options).toEqual({ idempotencyKey: 'order-order-1' });
    expect(params).toEqual({
      amount: 52,
      currency: 'usd',
      customer: 'cus_1',
      payment_method: 'pm_1',
      confirm: true,
      off_session: true,
      metadata: { orderId: 'order-1' },
      expand: ['latest_charge'],
    });
  }
});

it('leaves the receipt empty while the charge is not expanded', async () => {
  const create = vi.fn(() =>
    Promise.resolve({
      id: 'pi_2',
      status: 'processing',
      latest_charge: null,
    }),
  );
  const client = new SdkStripeClient(fakeStripe(create), limiterWith().limiter);
  await expect(client.createPayment(input)).resolves.toMatchObject({
    receiptUrl: null,
  });
});

it('maps a declined card to CardDeclinedError', async () => {
  const create = vi.fn(() => {
    return Promise.reject(
      new Stripe.errors.StripeCardError({
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Your card has insufficient funds.',
        payment_intent: { id: 'pi_declined' } as Stripe.PaymentIntent,
      }),
    );
  });
  const client = new SdkStripeClient(fakeStripe(create), limiterWith().limiter);
  const error = await client.createPayment(input).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CardDeclinedError);
  expect(error).toMatchObject({
    declineCode: 'insufficient_funds',
    intentId: 'pi_declined',
  });
  expect((error as Error).message).not.toMatch(/insufficient/);
});

it('maps a rate limit to a transient error and a cooldown', async () => {
  const create = vi.fn(() => {
    return Promise.reject(
      new Stripe.errors.StripeRateLimitError({
        type: 'invalid_request_error',
        code: 'rate_limit',
        message: 'Too many requests',
      }),
    );
  });
  const { limiter, reportCooldown } = limiterWith();
  const client = new SdkStripeClient(fakeStripe(create), limiter);
  await expect(client.createPayment(input)).rejects.toEqual(
    new RpcError('transient'),
  );
  expect(reportCooldown).toHaveBeenCalledTimes(1);
});

it.each([
  [new Stripe.errors.StripeConnectionError({ type: 'api_error' }), 'transient'],
  [
    new Stripe.errors.StripeAPIError({ type: 'api_error', statusCode: 503 }),
    'transient',
  ],
  [
    new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      message: 'No such customer',
    }),
    'permanent',
  ],
  [new Error('unexpected'), 'permanent'],
] as const)(
  'maps %s to a %s error without a cooldown',
  async (failure, kind) => {
    const create = vi.fn(() => {
      return Promise.reject(failure);
    });
    const { limiter, reportCooldown } = limiterWith();
    const client = new SdkStripeClient(fakeStripe(create), limiter);
    await expect(client.createPayment(input)).rejects.toEqual(
      new RpcError(kind),
    );
    expect(reportCooldown).not.toHaveBeenCalled();
  },
);

it('classifies an authentication or permission error as an access error', async () => {
  for (const [failure, statusCode] of [
    [Stripe.errors.StripeAuthenticationError, 401],
    [Stripe.errors.StripePermissionError, 403],
  ] as const) {
    const create = vi.fn(() => {
      return Promise.reject(
        new failure({ type: 'invalid_request_error', statusCode }),
      );
    });
    const client = new SdkStripeClient(
      fakeStripe(create),
      limiterWith().limiter,
    );
    const error = await client.createPayment(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeAccessError);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ kind: 'permanent' });
  }
  const noKey = new SdkStripeClient(undefined, limiterWith().limiter);
  await expect(noKey.retrieve('pi_1')).rejects.toBeInstanceOf(
    StripeAccessError,
  );
});

it('treats an idempotency conflict as transient', async () => {
  const create = vi.fn(() => {
    return Promise.reject(
      new Stripe.errors.StripeIdempotencyError({
        type: 'idempotency_error',
        statusCode: 409,
        message: 'A request with this key is still in progress',
      }),
    );
  });
  const { limiter, reportCooldown } = limiterWith();
  const client = new SdkStripeClient(fakeStripe(create), limiter);
  await expect(client.createPayment(input)).rejects.toEqual(
    new RpcError('transient'),
  );
  expect(reportCooldown).not.toHaveBeenCalled();
});

it('treats a 409 status as transient', async () => {
  const create = vi.fn(() => {
    return Promise.reject(
      new Stripe.errors.StripeAPIError({
        type: 'api_error',
        statusCode: 409,
      }),
    );
  });
  const client = new SdkStripeClient(fakeStripe(create), limiterWith().limiter);
  await expect(client.createPayment(input)).rejects.toEqual(
    new RpcError('transient'),
  );
});

it('retrieves a PaymentIntent with its charge', async () => {
  const retrieve = vi.fn(() => Promise.resolve(intent));
  const client = new SdkStripeClient(
    { paymentIntents: { retrieve } } as unknown as Stripe,
    limiterWith().limiter,
  );
  await expect(client.retrieve('pi_1')).resolves.toBe(intent);
  expect(retrieve).toHaveBeenCalledWith('pi_1', {
    expand: ['latest_charge'],
  });
});

it('searches the PaymentIntents of an order', async () => {
  const search = vi.fn(() => Promise.resolve({ data: [intent] }));
  const client = new SdkStripeClient(
    { paymentIntents: { search } } as unknown as Stripe,
    limiterWith().limiter,
  );
  await expect(client.search('order-1')).resolves.toEqual([intent]);
  expect(search).toHaveBeenCalledWith({
    query: "metadata['orderId']:'order-1'",
    expand: ['data.latest_charge'],
  });
});

it('maps lookup errors like charge errors', async () => {
  const failure = vi.fn(() => {
    return Promise.reject(
      new Stripe.errors.StripeRateLimitError({
        type: 'invalid_request_error',
        message: 'Too many requests',
      }),
    );
  });
  const { limiter, reportCooldown } = limiterWith();
  const client = new SdkStripeClient(
    {
      paymentIntents: { retrieve: failure, search: failure },
    } as unknown as Stripe,
    limiter,
  );
  await expect(client.retrieve('pi_1')).rejects.toEqual(
    new RpcError('transient'),
  );
  await expect(client.search('order-1')).rejects.toEqual(
    new RpcError('transient'),
  );
  expect(reportCooldown).toHaveBeenCalledTimes(2);
  await expect(
    new SdkStripeClient(undefined, limiter).retrieve('pi_1'),
  ).rejects.toMatchObject({ kind: 'permanent' });
});
