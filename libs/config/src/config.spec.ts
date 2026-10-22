import { apiSchema, buyerSchema, trackerSchema, validateConfig } from './index';

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
    [...shared, ...chain, 'SHOP_ADDRESS', 'NOTICE_SECRET', 'SHOP_NOTICE_URL'],
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
    expect(api.TRUST_PROXY).toBe(false);
    expect(api.RPC_REQUESTS_PER_SECOND_API).toBe(1);
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

  it('reads TRUST_PROXY=true', () => {
    expect(
      validateConfig(apiSchema, { ...minimal, TRUST_PROXY: 'true' })
        .TRUST_PROXY,
    ).toBe(true);
  });
});
