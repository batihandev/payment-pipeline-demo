import { testDatabase } from '../../../libs/db/testing/database';
import { expireOrders } from './expiry';
let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
it('expires open orders one minute past expiry and preserves unexpired and paid orders', async () => {
  const now = new Date('2026-10-20T12:00:00Z');
  for (const [item, status, expiresAt] of [
    ['Late', 'open', new Date(now.getTime() - 60000)],
    ['Open', 'open', new Date(now.getTime() + 60000)],
    ['Paid', 'paid', new Date(now.getTime() - 60000)],
  ] as const)
    await database.db.order.create({
      data: {
        item,
        status,
        expiresAt,
        price: 100n,
        expectedAmount: 101n,
        source: 'schedule',
      },
    });
  expect(await expireOrders(database.db, now)).toBe(1);
  expect(
    (await database.db.order.findMany({ orderBy: { item: 'asc' } })).map(
      ({ item, status }) => [item, status],
    ),
  ).toEqual([
    ['Late', 'expired'],
    ['Open', 'open'],
    ['Paid', 'paid'],
  ]);
  expect(await expireOrders(database.db, now)).toBe(0);
});
