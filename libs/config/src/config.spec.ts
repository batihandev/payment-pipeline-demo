import {
  apiSchema,
  buyerSchema,
  stripeSetupSchema,
  trackerSchema,
  validateConfig,
} from './index';

const shared = ['DATABASE_URL', 'REDIS_URL'];
const chain = ['CHAIN_ID', 'RPC_URL', 'USDC_ADDRESS'];

describe.each([
  [
    'buyer',
    buyerSchema,
    [...shared, ...chain, 'BUYER_PRIVATE_KEY', 'SHOP_PRIVATE_KEY'],
  ],
  [
    'tracker',
    trackerSchema,
    [
      ...shared,
      ...chain,
      'BUYER_ADDRESS',
      'SHOP_ADDRESS',
      'NOTICE_SECRET',
      'SHOP_NOTICE_URL',
    ],
  ],
  [
    'api',
    apiSchema,
    [
      ...shared,
      ...chain,
      'BUYER_ADDRESS',
      'SHOP_ADDRESS',
      'NOTICE_SECRET',
      'WEB_ORIGIN',
    ],
  ],
] as const)('%s startup configuration', (_app, schema, required) => {
  it('names every missing variable without including environment values', () => {
    let message = '';
    try {
      validateConfig(schema, { UNRELATED_SECRET: 'never-print-this' });
    } catch (error) {
      if (error instanceof Error) message = error.message;
    }
    for (const name of required) expect(message).toContain(name);
    expect(message).not.toContain('never-print-this');
  });
  it('accepts loopback HTTP URLs for local services', () => {
    expect(() =>
      validateConfig(schema, {
        DATABASE_URL:
          'postgresql://testnet:local_testnet@127.0.0.1:55432/testnet_payments',
        REDIS_URL: 'redis://127.0.0.1:56379',
        CHAIN_ID: '84532',
        RPC_URL: 'http://127.0.0.1:8545',
        USDC_ADDRESS: `0x${'33'.repeat(20)}`,
        BUYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        SHOP_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
        BUYER_ADDRESS: `0x${'11'.repeat(20)}`,
        SHOP_ADDRESS: `0x${'22'.repeat(20)}`,
        NOTICE_SECRET: 'local-test-secret-01234567890123456789',
        SHOP_NOTICE_URL: 'http://127.0.0.1:3000/shop/notices',
        WEB_ORIGIN: 'http://localhost:5173',
      }),
    ).not.toThrow();
  });
});

describe('visitor, refill and retention settings', () => {
  const minimal = {
    DATABASE_URL:
      'postgresql://testnet:local_testnet@127.0.0.1:55432/testnet_payments',
    REDIS_URL: 'redis://127.0.0.1:56379',
    CHAIN_ID: '84532',
    RPC_URL: 'http://127.0.0.1:8545',
    USDC_ADDRESS: `0x${'33'.repeat(20)}`,
    BUYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    SHOP_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
    BUYER_ADDRESS: `0x${'11'.repeat(20)}`,
    SHOP_ADDRESS: `0x${'22'.repeat(20)}`,
    NOTICE_SECRET: 'local-test-secret-01234567890123456789',
    SHOP_NOTICE_URL: 'http://127.0.0.1:3000/shop/notices',
    WEB_ORIGIN: 'http://localhost:5173',
  };

  it('applies the visitor, refill and retention defaults', () => {
    const api = validateConfig(apiSchema, minimal);
    expect(api.VISITOR_PER_MINUTE).toBe(10);
    expect(api.VISITOR_PER_DAY).toBe(100);
    expect(api.VISITOR_QUEUE_LIMIT).toBe(30);
    expect(api.VISITOR_DAILY_LIMIT).toBe(2000);
    expect(api.GAS_FLOOR).toBe(200000000000000n);
    expect(api.RETENTION_DAYS).toBe(30);
    expect(api.CLIENT_IP_HEADER).toBe(undefined);
    expect(api.RPC_REQUESTS_PER_SECOND_API).toBe(1);
    for (const config of [api, validateConfig(buyerSchema, minimal)])
      expect(config).toMatchObject({
        DATABASE_POOL_MAX: 10,
        DATABASE_CONNECT_TIMEOUT_MS: 5000,
        DATABASE_IDLE_TIMEOUT_MS: 10_000,
      });
    const buyer = validateConfig(buyerSchema, minimal);
    expect(buyer.DAILY_COUNT_CAP).toBe(100);
    expect(buyer.DAILY_AMOUNT_CAP).toBe(200000000n);
    expect(buyer.MAX_IN_FLIGHT).toBe(10);
    expect(buyer.REFILL_BELOW).toBe(5000000n);
    expect(buyer.REFILL_COOLDOWN_SECONDS).toBe(20);
    expect(buyer.RETENTION_DAYS).toBe(30);
    expect(buyer.RPC_REQUESTS_PER_SECOND_BUYER).toBe(2);
    const tracker = validateConfig(trackerSchema, minimal);
    expect(tracker.RPC_REQUESTS_PER_SECOND_TRACKER).toBe(2);
  });

  it('binds the API to loopback unless API_HOST says otherwise', () => {
    expect(validateConfig(apiSchema, minimal).API_HOST).toBe('127.0.0.1');
    expect(
      validateConfig(apiSchema, { ...minimal, API_HOST: '0.0.0.0' }).API_HOST,
    ).toBe('0.0.0.0');
    expect(
      validateConfig(apiSchema, { ...minimal, API_HOST: '::' }).API_HOST,
    ).toBe('::');
    expect(() =>
      validateConfig(apiSchema, { ...minimal, API_HOST: 'not a host' }),
    ).toThrow('API_HOST');
  });

  it('reads the client address header only when it is CF-Connecting-IP', () => {
    expect(
      validateConfig(apiSchema, { ...minimal, CLIENT_IP_HEADER: '' })
        .CLIENT_IP_HEADER,
    ).toBe(undefined);
    expect(
      validateConfig(apiSchema, {
        ...minimal,
        CLIENT_IP_HEADER: 'cf-connecting-ip',
      }).CLIENT_IP_HEADER,
    ).toBe('cf-connecting-ip');
    expect(() =>
      validateConfig(apiSchema, {
        ...minimal,
        CLIENT_IP_HEADER: 'x-forwarded-for',
      }),
    ).toThrow('CLIENT_IP_HEADER');
  });

  it('accepts a comma-separated list of web origins', () => {
    expect(validateConfig(apiSchema, minimal).WEB_ORIGIN).toEqual([
      'http://localhost:5173',
    ]);
    expect(
      validateConfig(apiSchema, {
        ...minimal,
        WEB_ORIGIN: ' https://example.com ,https://www.example.com,',
      }).WEB_ORIGIN,
    ).toEqual(['https://example.com', 'https://www.example.com']);
    for (const WEB_ORIGIN of [
      '',
      ' , ',
      'https://example.com,not a url',
      'ftp://example.com',
      'https://example.com/',
      'https://example.com/path',
    ])
      expect(() =>
        validateConfig(apiSchema, { ...minimal, WEB_ORIGIN }),
      ).toThrow('WEB_ORIGIN');
  });

  it('accepts only sandbox Stripe keys', () => {
    expect(validateConfig(buyerSchema, minimal).STRIPE_SECRET_KEY).toBe(
      undefined,
    );
    expect(
      validateConfig(buyerSchema, {
        ...minimal,
        STRIPE_SECRET_KEY: 'sk_test_abc',
      }).STRIPE_SECRET_KEY,
    ).toBe('sk_test_abc');
    expect(() =>
      validateConfig(buyerSchema, {
        ...minimal,
        STRIPE_SECRET_KEY: 'sk_live_abc',
      }),
    ).toThrow('STRIPE_SECRET_KEY');
  });

  it('accepts only whsec_ webhook secrets', () => {
    expect(() =>
      validateConfig(apiSchema, { ...minimal, STRIPE_WEBHOOK_SECRET: 'abc' }),
    ).toThrow('STRIPE_WEBHOOK_SECRET');
    expect(
      validateConfig(apiSchema, {
        ...minimal,
        STRIPE_WEBHOOK_SECRET: 'whsec_abc',
      }).STRIPE_WEBHOOK_SECRET,
    ).toBe('whsec_abc');
  });

  it('refuses a live key in the setup script', () => {
    expect(() =>
      validateConfig(stripeSetupSchema, { STRIPE_SECRET_KEY: 'sk_live_abc' }),
    ).toThrow('STRIPE_SECRET_KEY');
    expect(() => validateConfig(stripeSetupSchema, {})).toThrow(
      'STRIPE_SECRET_KEY',
    );
  });

  it('defaults the Stripe limiter to 5 a second', () => {
    expect(
      validateConfig(buyerSchema, minimal).STRIPE_REQUESTS_PER_SECOND,
    ).toBe(5);
  });

  it('defaults the setup payment method to the Visa test card', () => {
    expect(
      validateConfig(stripeSetupSchema, { STRIPE_SECRET_KEY: 'sk_test_abc' }),
    ).toEqual({
      STRIPE_SECRET_KEY: 'sk_test_abc',
      STRIPE_PAYMENT_METHOD: 'pm_card_visa',
    });
  });
});
