import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { Redis } from 'ioredis';
import { testDatabase } from '../../../../libs/db/testing/database';
import { ScriptedChain } from '../../../../libs/chain/testing/scripted-chain';
import { RedisLock } from '../sending/redis-lock';
import { OrderSenderService } from '../sending/order-sender.service';
import { SweepService } from './sweep.service';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import { fakeConfig } from '../../../../libs/config/testing/config';
import type { BuyerConfig } from '../buyer-config';
const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
const day = new Date('2026-10-20');
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let chain: ScriptedChain;
let sweep: SweepService;
beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis(testRedisUrl());
});
afterAll(async () => {
  await redis.quit();
  await database.close();
});
beforeEach(async () => {
  await database.db.incident.deleteMany();
  await database.db.sweep.deleteMany();
  await database.db.walletNonce.deleteMany();
  chain = new ScriptedChain();
  const sender = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'sweep-test'),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
  );
  sweep = new SweepService(database.db, chain, sender, shop);
});
it('sweeps the shop balance once per UTC night through the durable send path and records the result', async () => {
  await sweep.run(day);
  await sweep.run(day);
  expect(chain.signed).toBe(1);
  expect(await chain.getBalances(shop)).toMatchObject({ usdc: 0n });
  expect(await chain.getBalances(buyer)).toMatchObject({ usdc: 1000n });
  expect(chain.accepted.size).toBe(1);
  expect(
    await database.db.sweep.findUniqueOrThrow({ where: { id: '2026-10-20' } }),
  ).toMatchObject({ amount: 500n, sendState: 'sent', nonce: 3n });
  expect(await database.db.incident.count({ where: { kind: 'swept' } })).toBe(
    1,
  );
  expect(await database.db.order.count()).toBe(0);
  expect(await database.db.dailyBudget.count()).toBe(0);
});
it('retries a sweep with its saved amount and signature after an uncertain broadcast', async () => {
  chain.fail = 'broadcast';
  await expect(sweep.run(day)).rejects.toMatchObject({ kind: 'timeout' });
  chain.fail = null;
  chain.getBalances = () => Promise.resolve({ native: 1n, usdc: 1000n });
  await sweep.run(day);
  expect(chain.signed).toBe(1);
  expect(chain.accepted.size).toBe(1);
  expect(
    await database.db.sweep.findUniqueOrThrow({ where: { id: '2026-10-20' } }),
  ).toMatchObject({ amount: 500n, sendState: 'sent' });
});
it('leaves an empty shop balance alone without signing a zero transfer', async () => {
  chain.getBalances = () => Promise.resolve({ native: 1n, usdc: 0n });
  await sweep.run(day);
  expect(chain.signed).toBe(0);
  expect(await database.db.sweep.count()).toBe(0);
});

it('records a balance lookup failure without signing or losing the next retry', async () => {
  chain.getBalances = () => {
    return Promise.reject(new RpcError('rate_limit'));
  };
  await expect(sweep.run(day)).rejects.toMatchObject({ kind: 'rate_limit' });
  expect(chain.signed).toBe(0);
  const incident = await database.db.incident.findFirstOrThrow();
  expect(incident.kind).toBe('sweep_failed');
  expect(incident.howHandled).toContain('No transfer was signed');
  chain.getBalances = () => Promise.resolve({ native: 1n, usdc: 500n });
  await sweep.run(day);
  expect(chain.accepted.size).toBe(1);
});

it('records a concurrent rebroadcast of one sweep as one completed sweep', async () => {
  await database.db.sweep.create({ data: { id: '2026-10-20', amount: 500n } });
  let reached = 0;
  let release: () => void = () => undefined;
  const prepared = new Promise<void>((resolve) => {
    release = resolve;
  });
  const broadcast = chain.sendRawTransaction.bind(chain);
  chain.sendRawTransaction = async (raw) => {
    if (++reached === 2) release();
    await prepared;
    return broadcast(raw);
  };
  const other = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'other-sweep-lease'),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
  );
  await Promise.all([sweep.run(day), other.sendForSweep('2026-10-20')]);
  expect(chain.signed).toBe(1);
  expect(chain.accepted.size).toBe(1);
  expect(await database.db.incident.count({ where: { kind: 'swept' } })).toBe(
    1,
  );
});
