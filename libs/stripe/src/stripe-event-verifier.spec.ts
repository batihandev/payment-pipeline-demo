import Stripe from 'stripe';
import { SdkStripeEventVerifier } from './stripe-event-verifier';

const secret = 'whsec_test';
const body = Buffer.from(
  JSON.stringify({ id: 'evt_1', object: 'event', type: 'x' }),
);
const sign = (key: string) =>
  Stripe.webhooks.generateTestHeaderString({
    payload: body.toString(),
    secret: key,
  });

it('verifies an event without a secret key', () => {
  const verifier = new SdkStripeEventVerifier(secret);
  expect(verifier.verifyEvent(body, sign(secret)).id).toBe('evt_1');
});

it('rejects an event with a bad signature', () => {
  const verifier = new SdkStripeEventVerifier(secret);
  expect(() => verifier.verifyEvent(body, sign('whsec_other'))).toThrow(
    Stripe.errors.StripeSignatureVerificationError,
  );
});

it('refuses to verify without a webhook secret', () => {
  const verifier = new SdkStripeEventVerifier(undefined);
  expect(() => verifier.verifyEvent(body, 'sig')).toThrow(
    'Stripe webhook secret is not configured',
  );
});
