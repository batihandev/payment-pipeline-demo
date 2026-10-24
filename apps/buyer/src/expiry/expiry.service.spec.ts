import { afterAll, beforeAll, expect, it } from 'vitest';
import { testDatabase } from '@testing/db/database';
import { ExpiryService } from './expiry.service';
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
  expect(await new ExpiryService(database.db).expireOrders(now)).toBe(1);
  expect(
    (await database.db.order.findMany({ orderBy: { item: 'asc' } })).map(
      ({ item, status }) => [item, status],
    ),
  ).toEqual([
    ['Late', 'expired'],
    ['Open', 'open'],
    ['Paid', 'paid'],
  ]);
  expect(await new ExpiryService(database.db).expireOrders(now)).toBe(0);
});
it('records an order event for each order it expires', async () => {
  await database.db.order.deleteMany();
  const now = new Date('2026-10-21T12:00:00Z');
  const late = await database.db.order.create({
    data: {
      item: 'Late',
      expiresAt: new Date(now.getTime() - 60000),
      price: 100n,
      expectedAmount: 101n,
      source: 'visitor',
    },
  });
  await new ExpiryService(database.db).expireOrders(now);
  expect(
    await database.db.orderEvent.findMany({ select: { orderId: true } }),
  ).toEqual([{ orderId: late.id }]);
});
