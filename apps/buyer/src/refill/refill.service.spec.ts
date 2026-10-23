import { Redis } from 'ioredis';
import { testDatabase } from '../../../../libs/db/testing/database';
import { ScriptedChain } from '../../../../libs/chain/testing/scripted-chain';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import { RedisLock } from '../sending/redis-lock';
import { OrderSenderService } from '../sending/order-sender.service';
import { RefillService } from './refill.service';
import { SweepService } from '../sweep/sweep.service';
import { fakeConfig } from '../../../../libs/config/testing/config';
import type { BuyerConfig } from '../buyer-config';
const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let chain: ScriptedChain;
let sender: OrderSenderService;
let clock: Date;
let refill: RefillService;
let usdc: Record<string, bigint>;
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
  usdc = { [buyer]: 4_999_999n, [shop]: 38_000_000n };
  chain.getBalances = (address) =>
    Promise.resolve({
      native: 1n,
      usdc: usdc[address] ?? 0n,
    });
  sender = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, 'refill-test'),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
  );
  clock = new Date('2026-10-22T10:00:00.000Z');
  refill = new RefillService(
    database.db,
    chain,
    sender,
    buyer,
    shop,
    fakeConfig<BuyerConfig>({
      REFILL_BELOW: 5_000_000n,
      REFILL_COOLDOWN_SECONDS: 20,
    }),
    () => clock,
  );
});
it('refills when the buyer is below the threshold', async () => {
  expect(await refill.run()).toBe('sent');
  const sweeps = await database.db.sweep.findMany();
  expect(sweeps).toHaveLength(1);
  expect(sweeps[0]).toMatchObject({
    id: 'refill:2026-10-22T10:00:00.000Z',
    amount: 38_000_000n,
    sendState: 'sent',
  });
  expect(chain.signed).toBe(1);
  const incident = await database.db.incident.findFirstOrThrow();
  expect(incident).toMatchObject({
    kind: 'refilled',
    whatHappened: 'Refilled the buyer with 38000000 micro-units from the shop.',
  });
  expect(incident.howHandled).toContain(
    'for refill refill:2026-10-22T10:00:00.000Z',
  );
  expect(`${incident.whatHappened} ${incident.howHandled}`).not.toMatch(
    /sweep|swept/i,
  );
});
it('does nothing above the threshold', async () => {
  usdc[buyer] = 5_000_000n;
  expect(await refill.run()).toBe('not-needed');
  expect(chain.signed).toBe(0);
  expect(await database.db.sweep.count()).toBe(0);
});
it('waits out the cooldown', async () => {
  expect(await refill.run()).toBe('sent');
  clock = new Date(clock.getTime() + 10_000);
  expect(await refill.run()).toBe('cooling-down');
  expect(chain.signed).toBe(1);
  clock = new Date(clock.getTime() + 11_000);
  expect(await refill.run()).toBe('sent');
  expect(await database.db.sweep.count()).toBe(2);
});
it('refills again at the cooldown despite scheduler jitter', async () => {
  expect(await refill.run()).toBe('sent');
  clock = new Date(clock.getTime() + 20_000 - 500);
  expect(await refill.run()).toBe('sent');
  expect(await database.db.sweep.count()).toBe(2);
});
it('still waits when well inside the cooldown', async () => {
  expect(await refill.run()).toBe('sent');
  clock = new Date(clock.getTime() + 20_000 - 1_500);
  expect(await refill.run()).toBe('cooling-down');
  expect(await database.db.sweep.count()).toBe(1);
});
it('skips an empty shop', async () => {
  usdc[shop] = 0n;
  expect(await refill.run()).toBe('shop-empty');
  expect(chain.signed).toBe(0);
  expect(await database.db.sweep.count()).toBe(0);
});
it('skips a shop without gas', async () => {
  const balances = chain.getBalances;
  chain.getBalances = async (address) => ({
    ...(await balances(address)),
    native: address === shop ? 0n : 1n,
  });
  expect(await refill.run()).toBe('shop-empty');
  expect(chain.signed).toBe(0);
});
it('resumes an unsent refill instead of waiting out the cooldown', async () => {
  chain.fail = 'broadcast';
  await expect(refill.run()).rejects.toMatchObject({ kind: 'timeout' });
  chain.fail = null;
  expect(await refill.run()).toBe('sent');
  expect(chain.signed).toBe(1);
  expect(await database.db.sweep.count()).toBe(1);
});
it('signs refill and nightly sweep with distinct shop nonces', async () => {
  const nightly = new SweepService(database.db, chain, sender, shop);
  await refill.run();
  await nightly.run(new Date('2026-10-22'));
  expect(chain.signedNonces).toHaveLength(2);
  const [first, second] = chain.signedNonces;
  expect(second).toBe((first ?? 0) + 1);
});
