import { Redis } from 'ioredis';
import { generatePrivateKey } from 'viem/accounts';
import { ScriptedChain } from '@testing/chain/scripted-chain';
import { buyerSchema, validateConfig } from '@app/config';
import { fakeConfig } from '@testing/config/config';
import { testRedisUrl } from '@testing/config/redis';
import { databasePool } from '@app/db';
import { testDatabase } from '@testing/db/database';
import type { BuyerConfig } from '../buyer-config';
import { OrderSenderService } from './order-sender.service';
import { RedisLock } from './redis-lock';

/**
 * The buyer runs two workers with a concurrency of one each, and either can hold a nonce
 * transaction open across its RPC calls: the buyer worker for an order, the upkeep worker
 * for a sweep or refill from the other wallet.
 */
const HELD_NONCE_TRANSACTIONS = 2;

const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
const config = validateConfig(buyerSchema, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  REDIS_URL: testRedisUrl(),
  CHAIN_ID: '84532',
  RPC_URL: 'https://example.com',
  USDC_ADDRESS: `0x${'33'.repeat(20)}`,
  BUYER_PRIVATE_KEY: generatePrivateKey(),
  SHOP_PRIVATE_KEY: generatePrivateKey(),
});

let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
beforeAll(async () => {
  const { connectionString: _url, ...pool } = databasePool(config);
  database = await testDatabase(pool);
  redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 1 });
});
afterAll(async () => {
  await redis.quit();
  await database.close();
});

it('leaves a pool connection free while both workers hold a nonce transaction', async () => {
  // Each held transaction keeps one connection, and the other queries need one more.
  expect(config.DATABASE_POOL_MAX).toBeGreaterThan(HELD_NONCE_TRANSACTIONS);
  const { db } = database;
  const order = await db.order.create({
    data: {
      item: 'Duck',
      price: 99n,
      expectedAmount: 100n,
      source: 'visitor',
      expiresAt: new Date(Date.now() + 1_800_000),
    },
  });
  await db.sweep.create({ data: { id: 'pool-sweep', amount: 50n } });
  const chain = new ScriptedChain();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let holding!: () => void;
  const allHolding = new Promise<void>((resolve) => (holding = resolve));
  let inside = 0;
  // A wallet with no nonce row is seeded from the chain inside its nonce transaction.
  chain.getNonce = async () => {
    if (++inside === HELD_NONCE_TRANSACTIONS) holding();
    await gate;
    return chain.nonce;
  };
  const sender = new OrderSenderService(
    db,
    chain,
    chain,
    new RedisLock(redis, `nonce-pool-${Date.now()}`),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
  );
  const sends = Promise.all([
    sender.sendForOrder(order.id),
    sender.sendForSweep('pool-sweep'),
  ]);
  try {
    await allHolding;
    await expect(db.order.count()).resolves.toBe(1);
  } finally {
    release();
    await sends;
  }
  expect(chain.signed).toBe(HELD_NONCE_TRANSACTIONS);
}, 20_000);
