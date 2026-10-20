import { Redis } from 'ioredis';
import { testDatabase } from '../../../libs/db/src/test-database';
import { ScriptedChain } from './scripted-chain.test-support';
import { RedisLock } from './redis-lock';
import { OrderSender } from './send-order';
import { NightlySweep } from './sweep';
const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
const day = new Date('2026-10-20');
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let chain: ScriptedChain;
let sweep: NightlySweep;
beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis('redis://127.0.0.1:56379');
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
  const sender = new OrderSender(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'sweep-test'),
    { buyer, shop, chainId: 84532 },
  );
  sweep = new NightlySweep(database.db, chain, sender, shop);
});
it('sweeps the shop balance once per UTC night through the durable send path and records the result', async () => {
  await sweep.run(day);
  await sweep.run(day);
  expect(chain.signed).toBe(1);
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
  chain.getBalances = async () => ({ native: 1n, usdc: 1000n });
  await sweep.run(day);
  expect(chain.signed).toBe(1);
  expect(chain.accepted.size).toBe(1);
  expect(
    await database.db.sweep.findUniqueOrThrow({ where: { id: '2026-10-20' } }),
  ).toMatchObject({ amount: 500n, sendState: 'sent' });
});
it('leaves an empty shop balance alone without signing a zero transfer', async () => {
  chain.getBalances = async () => ({ native: 1n, usdc: 0n });
  await sweep.run(day);
  expect(chain.signed).toBe(0);
  expect(await database.db.sweep.count()).toBe(0);
});
