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
