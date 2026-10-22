import { randomUUID } from 'node:crypto';
import { dailyTarget } from '../../../libs/core/src/pacing';
import { testDatabase } from '../../../libs/db/testing/database';
import { Purchases } from './purchases';

const now = new Date('2026-10-20T12:00:00Z');
const day = new Date('2026-10-20');
const options = {
  cap: { count: 20, amount: 100000000n },
  seed: '84532',
  ttlMinutes: 30,
  quietStart: 0,
  quietEnd: 7,
};
let database: Awaited<ReturnType<typeof testDatabase>>;
let purchases: Purchases;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.db.order.deleteMany();
  await database.db.dailyBudget.deleteMany();
  purchases = new Purchases(database.db, options, () => 0);
});
it('creates today’s stable target on first use without replacing a saved target after restart', async () => {
  await purchases.ensureBudget(now);
  const target = dailyTarget(options.cap, day, options.seed);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ targetCount: target.count, targetAmount: target.amount });
  const restarted = new Purchases(
    database.db,
    { ...options, cap: { count: 100, amount: 999999999n } },
    () => 0,
  );
  await restarted.ensureBudget(now);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ targetCount: target.count, targetAmount: target.amount });
});
it('creates no order when the daily count budget is spent', async () => {
  await database.db.dailyBudget.create({
    data: { day, targetCount: 1, targetAmount: 100000000n, reservedCount: 1 },
  });
  expect(await purchases.pace(now)).toBeNull();
  expect(await database.db.order.count()).toBe(0);
});
it('reuses the same scheduled order after a restart before enqueueing', async () => {
  const first = await purchases.pace(now);
  expect(first).not.toBeNull();
  const retry = await new Purchases(database.db, options, () => 0).pace(now);
  expect(retry?.id).toBe(first?.id);
  expect(await database.db.order.count()).toBe(1);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: first?.expectedAmount });
});
it('applies quiet-window pacing while visitor purchases skip the pacing draw', async () => {
  purchases = new Purchases(database.db, options, () => 0.5);
  expect(await purchases.pace(new Date('2026-10-20T01:00:00Z'))).toBeNull();
  const visitor = await purchases.visitor(randomUUID(), now);
  expect(visitor).toMatchObject({ source: 'visitor', status: 'open' });
});
it('creates a visitor order when the daily budget is spent', async () => {
  await database.db.dailyBudget.create({
    data: {
      day,
      targetCount: 1,
      targetAmount: 100000000n,
      reservedCount: 1,
      reservedAmount: 100000000n,
    },
  });
  const order = await purchases.visitor(randomUUID(), now);
  expect(order).toMatchObject({ source: 'visitor', status: 'open' });
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 100000000n });
});
it('refuses visitors past the daily visitor limit', async () => {
  await purchases.pace(now);
  expect(await purchases.visitor(randomUUID(), now, 2)).not.toBeNull();
  expect(await purchases.visitor(randomUUID(), now, 2)).not.toBeNull();
  expect(await purchases.visitor(randomUUID(), now, 2)).toBeNull();
  expect(await purchases.visitorsToday(now)).toBe(2);
  expect(await database.db.order.count()).toBe(3);
});
it('counts visitor orders only for the UTC day of now', async () => {
  await purchases.visitor(randomUUID(), new Date('2026-10-19T23:59:00Z'));
  expect(await purchases.visitorsToday(now)).toBe(0);
  expect(await purchases.visitor(randomUUID(), now, 1)).not.toBeNull();
});
it('creates only the allowed number of visitor orders when clicks compete for the limit', async () => {
  const results = await Promise.all([
    purchases.visitor(randomUUID(), now, 1),
    purchases.visitor(randomUUID(), now, 1),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await database.db.order.count()).toBe(1);
});
it('returns the existing visitor order on retry even at the limit and reserves nothing', async () => {
  const id = randomUUID();
  const first = await purchases.visitor(id, now, 1);
  expect(await purchases.visitor(id, now, 1)).toEqual(first);
  expect(await purchases.visitor(id, now)).toEqual(first);
  expect(await database.db.order.count()).toBe(1);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
});
it('keeps offsets unique among orders from the last 24 hours including expired orders', async () => {
  const old = await purchases.visitor(
    randomUUID(),
    new Date('2026-10-19T23:59:00Z'),
  );
  if (!old) throw new Error('Expected order');
  await database.db.order.update({
    where: { id: old.id },
    data: { status: 'expired' },
  });
  const next = await purchases.visitor(randomUUID(), now);
  expect(next?.expectedAmount).not.toBe(old.expectedAmount);
});
it('initializes a missing daily target once when first purchases start concurrently', async () => {
  await Promise.all(
    Array.from({ length: 20 }, () => purchases.ensureBudget(now)),
  );
  expect(await database.db.dailyBudget.count()).toBe(1);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
});
