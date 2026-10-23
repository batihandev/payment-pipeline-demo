import Stripe from 'stripe';
import { RpcError } from '../../chain/src/rpc-error';
import { RpcLimiter } from '../../chain/src/rpc-limiter';
import { CardDeclinedError, SdkStripeClient } from './stripe-client';

const input = {
  amountCents: 52,
  customer: 'cus_1',
  paymentMethod: 'pm_1',
  orderId: 'order-1',
};

function fakeStripe(create: jest.Mock) {
  return { paymentIntents: { create } } as unknown as Stripe;
}

function limiterWith(reportCooldown = jest.fn(async () => undefined)) {
  return {
    reportCooldown,
    limiter: new RpcLimiter(
      1000,
      1000,
      Date.now,
      async () => undefined,
      reportCooldown,
    ),
  };
}

const intent = {
  id: 'pi_1',
  status: 'processing',
  latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/1' },
};

it('creates the payment once per order', async () => {
  const create = jest.fn(async () => intent);
  const client = new SdkStripeClient(
    fakeStripe(create),
    undefined,
    limiterWith().limiter,
  );
  const first = await client.createPayment(input);
  const retry = await client.createPayment(input);
  expect(first).toEqual({
    id: 'pi_1',
    status: 'processing',
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
  const create = jest.fn(async () => ({
    id: 'pi_2',
    status: 'processing',
    latest_charge: null,
  }));
  const client = new SdkStripeClient(
    fakeStripe(create),
    undefined,
    limiterWith().limiter,
  );
  await expect(client.createPayment(input)).resolves.toMatchObject({
    receiptUrl: null,
  });
});

it('maps a declined card to CardDeclinedError', async () => {
  const create = jest.fn(async () => {
    throw new Stripe.errors.StripeCardError({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'insufficient_funds',
      message: 'Your card has insufficient funds.',
    });
  });
  const client = new SdkStripeClient(
    fakeStripe(create),
    undefined,
    limiterWith().limiter,
  );
  const error = await client.createPayment(input).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CardDeclinedError);
  expect(error).toMatchObject({ declineCode: 'insufficient_funds' });
  expect((error as Error).message).not.toMatch(/insufficient/);
});

it('maps a rate limit to a transient error and a cooldown', async () => {
  const create = jest.fn(async () => {
    throw new Stripe.errors.StripeRateLimitError({
      type: 'invalid_request_error',
      code: 'rate_limit',
      message: 'Too many requests',
    });
  });
  const { limiter, reportCooldown } = limiterWith();
  const client = new SdkStripeClient(fakeStripe(create), undefined, limiter);
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
    const create = jest.fn(async () => {
      throw failure;
    });
    const { limiter, reportCooldown } = limiterWith();
    const client = new SdkStripeClient(fakeStripe(create), undefined, limiter);
    await expect(client.createPayment(input)).rejects.toEqual(
      new RpcError(kind),
    );
    expect(reportCooldown).not.toHaveBeenCalled();
  },
);

describe('verifyEvent', () => {
  const stripe = new Stripe('sk_test_unused');
  const secret = 'whsec_test';
  const body = Buffer.from(
    JSON.stringify({ id: 'evt_1', object: 'event', type: 'x' }),
  );
  const client = new SdkStripeClient(stripe, secret, limiterWith().limiter);

  it('returns the event of a correctly signed body', () => {
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: body.toString(),
      secret,
    });
    expect(client.verifyEvent(body, signature).id).toBe('evt_1');
  });

  it('rejects an event with a bad signature', () => {
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: body.toString(),
      secret: 'whsec_other',
    });
    expect(() => client.verifyEvent(body, signature)).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );
  });

  it('refuses to verify without a webhook secret', () => {
    const unsigned = new SdkStripeClient(
      stripe,
      undefined,
      limiterWith().limiter,
    );
    expect(() => unsigned.verifyEvent(body, 'sig')).toThrow(
      'Stripe webhook secret is not configured',
    );
  });
});
