import { createHash, randomUUID } from 'node:crypto';
import { catalogue } from '@app/core/catalogue';
import { dailyTarget } from '@app/core/pacing';
import { testDatabase } from '@testing/db/database';
import { CustomersService } from './customers.service';
import { PurchasesService, purchaseOptions } from './purchases.service';

const now = new Date('2026-10-20T12:00:00Z');
const day = new Date('2026-10-20');
const options = {
  cap: { count: 20, amount: 100000000n },
  seed: '84532',
  ttlMinutes: 30,
  quietStart: 0,
  quietEnd: 7,
  cardRail: true,
};
let database: Awaited<ReturnType<typeof testDatabase>>;
let purchases: PurchasesService;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.db.order.deleteMany();
  await database.db.customer.deleteMany();
  await database.db.dailyBudget.deleteMany();
  purchases = new PurchasesService(
    database.db,
    options,
    () => 0,
    new CustomersService(database.db),
  );
});
it('creates today’s stable target on first use without replacing a saved target after restart', async () => {
  await purchases.ensureBudget(now);
  const target = dailyTarget(options.cap, day, options.seed);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ targetCount: target.count, targetAmount: target.amount });
  const restarted = new PurchasesService(
    database.db,
    { ...options, cap: { count: 100, amount: 999999999n } },
    () => 0,
    new CustomersService(database.db),
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
  const retry = await new PurchasesService(
    database.db,
    options,
    () => 0,
    new CustomersService(database.db),
  ).pace(now);
  expect(retry?.id).toBe(first?.id);
  expect(await database.db.order.count()).toBe(1);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: first?.expectedAmount });
});
it('applies quiet-window pacing while visitor purchases skip the pacing draw', async () => {
  purchases = new PurchasesService(
    database.db,
    options,
    () => 0.5,
    new CustomersService(database.db),
  );
  expect(await purchases.pace(new Date('2026-10-20T01:00:00Z'))).toBeNull();
  const visitor = await purchases.visitor(randomUUID(), 'chain', now);
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
  const order = await purchases.visitor(randomUUID(), 'chain', now);
  expect(order).toMatchObject({ source: 'visitor', status: 'open' });
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 100000000n });
});
it('refuses visitors past the daily visitor limit', async () => {
  await purchases.pace(now);
  expect(await purchases.visitor(randomUUID(), 'chain', now, 2)).not.toBeNull();
  expect(await purchases.visitor(randomUUID(), 'chain', now, 2)).not.toBeNull();
  expect(await purchases.visitor(randomUUID(), 'chain', now, 2)).toBeNull();
  expect(await purchases.visitorsToday(now)).toBe(2);
  expect(await database.db.order.count()).toBe(3);
});
it('counts visitor orders only for the UTC day of now', async () => {
  await purchases.visitor(
    randomUUID(),
    'chain',
    new Date('2026-10-19T23:59:00Z'),
  );
  expect(await purchases.visitorsToday(now)).toBe(0);
  expect(await purchases.visitor(randomUUID(), 'chain', now, 1)).not.toBeNull();
});
it('creates only the allowed number of visitor orders when clicks compete for the limit', async () => {
  const results = await Promise.all([
    purchases.visitor(randomUUID(), 'chain', now, 1),
    purchases.visitor(randomUUID(), 'chain', now, 1),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await database.db.order.count()).toBe(1);
});
it('returns the existing visitor order on retry even at the limit and reserves nothing', async () => {
  const id = randomUUID();
  const first = await purchases.visitor(id, 'chain', now, 1);
  expect(await purchases.visitor(id, 'chain', now, 1)).toEqual(first);
  expect(await purchases.visitor(id, 'chain', now)).toEqual(first);
  expect(await database.db.order.count()).toBe(1);
  expect(
    await database.db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
});
it('keeps offsets unique among orders from the last 24 hours including expired orders', async () => {
  const old = await purchases.visitor(
    randomUUID(),
    'chain',
    new Date('2026-10-19T23:59:00Z'),
  );
  if (!old) throw new Error('Expected order');
  await database.db.order.update({
    where: { id: old.id },
    data: { status: 'expired' },
  });
  const next = await purchases.visitor(randomUUID(), 'chain', now);
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
const savedCard = {
  name: 'Demo customer',
  stripeCustomerId: 'cus_demo',
  stripePaymentMethodId: 'pm_demo',
  cardBrand: 'visa',
  cardLast4: '4242',
};
const paidByCard = (orderId: string) =>
  createHash('sha256').update(orderId).digest().readUInt8(0) % 3 === 0;
it('creates a card order at the item price without an offset', async () => {
  const customer = await database.db.customer.create({ data: savedCard });
  const order = await purchases.visitor(randomUUID(), 'card', now);
  const item = catalogue[0];
  expect(order).toMatchObject({
    rail: 'card',
    customerId: customer.id,
    item: item.name,
    price: item.priceCents * 10000n,
    expectedAmount: item.priceCents * 10000n,
  });
});
it('creates chain orders with a unique offset and the demo customer', async () => {
  const customer = await database.db.customer.create({ data: savedCard });
  const order = await purchases.visitor(randomUUID(), 'chain', now);
  expect(order).toMatchObject({ rail: 'chain', customerId: customer.id });
  expect(order?.expectedAmount).not.toBe(order?.price);
});
it('leaves the customer empty when no customer row exists', async () => {
  expect(await purchases.visitor(randomUUID(), 'chain', now)).toMatchObject({
    rail: 'chain',
    customerId: null,
  });
});
it('schedules one in three purchases by card when a card is saved', async () => {
  await database.db.customer.create({ data: savedCard });
  purchases = new PurchasesService(
    database.db,
    { ...options, cap: { count: 500, amount: 100000000000n } },
    () => 0,
    new CustomersService(database.db),
  );
  const orders = [];
  for (let minute = 0; minute < 30; minute++) {
    const order = await purchases.pace(
      new Date(now.getTime() + minute * 60000),
    );
    if (order) orders.push(order);
  }
  expect(orders).toHaveLength(30);
  for (const order of orders)
    expect(order.rail).toBe(paidByCard(order.id) ? 'card' : 'chain');
  const cards = orders.filter((order) => order.rail === 'card').length;
  expect(cards).toBeGreaterThan(0);
  expect(cards).toBeLessThan(orders.length - cards);
});
it('schedules every purchase on chain without a saved card', async () => {
  await database.db.customer.create({
    data: { name: 'Demo customer', stripeCustomerId: 'cus_demo' },
  });
  purchases = new PurchasesService(
    database.db,
    { ...options, cap: { count: 500, amount: 100000000000n } },
    () => 0,
    new CustomersService(database.db),
  );
  for (let minute = 0; minute < 12; minute++)
    expect(
      (await purchases.pace(new Date(now.getTime() + minute * 60000)))?.rail,
    ).toBe('chain');
});
it('schedules exactly the card ids among fixed ids', async () => {
  await database.db.customer.create({ data: savedCard });
  const customers = new CustomersService(database.db);
  const demo = jest.spyOn(customers, 'demo');
  purchases = new PurchasesService(
    database.db,
    { ...options, cap: { count: 500, amount: 100000000000n } },
    () => 0,
    customers,
  );
  const cards = [];
  for (let minute = 0; minute < 30; minute++) {
    const order = await purchases.pace(
      new Date(now.getTime() + minute * 60000),
    );
    if (order?.rail === 'card') cards.push(order.id);
  }
  expect(cards).toEqual([
    'fd7a6641-20ea-9141-a35d-1e2e96e2a5e4',
    '2e9dd3ee-14e4-e0f7-c4db-fec95727a59f',
    '3dc94ceb-183f-659a-06c4-ecc5066e1dad',
    '9cf00966-1332-900f-f59d-e2a38b725101',
    '9d10bfe8-2c96-3475-3f4a-d9c6518b276e',
    'ae94cba4-8e98-a241-f7f4-f60939d4d12d',
    '7181d6cf-bb09-352e-e778-74bdce796748',
    '663d43c5-6e35-347f-a401-508dc5354c97',
  ]);
  expect(demo).toHaveBeenCalledTimes(30);
});
it('schedules no card purchases without a Stripe key', async () => {
  await database.db.customer.create({ data: savedCard });
  purchases = new PurchasesService(
    database.db,
    {
      ...purchaseOptions({
        DAILY_COUNT_CAP: 500,
        DAILY_AMOUNT_CAP: 100000000000n,
        CHAIN_ID: 84532,
        ORDER_TTL_MINUTES: 30,
        QUIET_START_HOUR_UTC: 0,
        QUIET_END_HOUR_UTC: 7,
        STRIPE_SECRET_KEY: undefined,
      }),
    },
    () => 0,
    new CustomersService(database.db),
  );
  const rails = new Set<string>();
  for (let minute = 0; minute < 30; minute++)
    rails.add(
      (await purchases.pace(new Date(now.getTime() + minute * 60000)))?.rail ??
        'none',
    );
  expect([...rails]).toEqual(['chain']);
});
it('counts card and chain purchases against one visitor limit', async () => {
  expect(await purchases.visitor(randomUUID(), 'card', now, 2)).not.toBeNull();
  expect(await purchases.visitor(randomUUID(), 'chain', now, 2)).not.toBeNull();
  expect(await purchases.visitor(randomUUID(), 'card', now, 2)).toBeNull();
  expect(await purchases.visitorsToday(now)).toBe(2);
});
it('reserves scheduled budget for a card order at its exact amount', async () => {
  await database.db.customer.create({ data: savedCard });
  purchases = new PurchasesService(
    database.db,
    { ...options, cap: { count: 500, amount: 100000000000n } },
    () => 0,
    new CustomersService(database.db),
  );
  const orders = [];
  for (let minute = 0; minute < 30; minute++) {
    const order = await purchases.pace(
      new Date(now.getTime() + minute * 60000),
    );
    if (order?.rail === 'card') orders.push(order);
  }
  expect(orders.length).toBeGreaterThan(0);
  for (const order of orders) expect(order.expectedAmount).toBe(order.price);
});
