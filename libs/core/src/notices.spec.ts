import { signNotice, verifyNotice } from './notices';

const body = '{"paymentId":"payment-1"}';
const secret = 'test-notice-secret';
const timestamp = 1792497600;
const signature =
  'edb4813687bbd94b9a4615338e17be77f449895537510b8af435974481598f7a';

it('signs the timestamp and exact JSON bytes with HMAC-SHA256', () => {
  expect(signNotice(body, secret, timestamp)).toBe(signature);
});

it('accepts a valid notice up to five minutes old', () => {
  expect(verifyNotice(body, secret, timestamp, signature, timestamp)).toBe(
    true,
  );
  expect(
    verifyNotice(body, secret, timestamp, signature, timestamp + 300),
  ).toBe(true);
});

it('rejects a tampered body including changes to JSON whitespace', () => {
  expect(
    verifyNotice(
      '{"paymentId":"payment-2"}',
      secret,
      timestamp,
      signature,
      timestamp,
    ),
  ).toBe(false);
  expect(
    verifyNotice(
      '{ "paymentId": "payment-1" }',
      secret,
      timestamp,
      signature,
      timestamp,
    ),
  ).toBe(false);
});

it('rejects a notice signed with the wrong secret', () => {
  expect(
    verifyNotice(body, 'wrong-secret', timestamp, signature, timestamp),
  ).toBe(false);
});

it('rejects a notice older than five minutes', () => {
  expect(
    verifyNotice(body, secret, timestamp, signature, timestamp + 301),
  ).toBe(false);
});

it('rejects changing the timestamp to renew an expired signature', () => {
  expect(
    verifyNotice(body, secret, timestamp + 301, signature, timestamp + 301),
  ).toBe(false);
});

it('rejects future or malformed timestamps', () => {
  expect(verifyNotice(body, secret, timestamp, signature, timestamp - 1)).toBe(
    false,
  );
  for (const invalid of [NaN, Infinity, -1, timestamp + 0.5]) {
    expect(verifyNotice(body, secret, invalid, signature, timestamp)).toBe(
      false,
    );
  }
});

it('rejects malformed signatures without throwing', () => {
  for (const invalid of [
    '',
    'abc',
    'z'.repeat(64),
    signature + '00',
    '0'.repeat(64),
  ]) {
    expect(verifyNotice(body, secret, timestamp, invalid, timestamp)).toBe(
      false,
    );
  }
});

it('rejects verification when the current time is invalid', () => {
  for (const now of [NaN, Infinity, -1, timestamp + 0.5]) {
    expect(verifyNotice(body, secret, timestamp, signature, now)).toBe(false);
  }
});
