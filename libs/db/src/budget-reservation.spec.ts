import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client';
import { BudgetReservation } from './budget-reservation';

const day = new Date('2026-10-20T00:00:00Z');
const schema = `budget_test_${randomUUID().replaceAll('-', '')}`;
let db: PrismaClient;
let admin: PrismaClient;
let budget: BudgetReservation;

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error(
      'TEST_DATABASE_URL is required for Postgres reservation tests',
    );
  admin = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString() }, { schema }),
  });
  const migrations = join(__dirname, '../prisma/migrations');
  for (const entry of readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = readFileSync(
      join(migrations, entry.name, 'migration.sql'),
      'utf8',
    );
    for (const statement of sql.split(';').filter((part) => part.trim())) {
      await db.$executeRawUnsafe(statement);
    }
  }
  budget = new BudgetReservation(db);
}, 30000);

beforeEach(async () => {
  await db.order.deleteMany();
  await db.dailyBudget.deleteMany();
});

afterAll(async () => {
  await db?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  }
});

it('accepts exactly five of twenty concurrent reservations with room for five', async () => {
  await db.dailyBudget.create({
    data: { day, targetCount: 5, targetAmount: 500n },
  });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => budget.reserve(day, 100n)),
  );
  expect(results.filter(Boolean)).toHaveLength(5);
  expect(
    await db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 5, reservedAmount: 500n });
});

it('creates exactly one visitor order when two purchases compete for the last reservation', async () => {
  await db.dailyBudget.create({
    data: { day, targetCount: 1, targetAmount: 14000731n },
  });
  const purchase = () =>
    db.$transaction(async (tx) => {
      if (!(await new BudgetReservation(tx).reserve(day, 14000731n)))
        return 'budget-spent';
      return tx.order.create({
        data: {
          item: 'Gold rubber duck',
          price: 14000000n,
          expectedAmount: 14000731n,
          source: 'visitor',
          expiresAt: new Date(day.getTime() + 1800000),
        },
      });
    });
  const results = await Promise.all([purchase(), purchase()]);
  expect(results.filter((result) => result === 'budget-spent')).toHaveLength(1);
  expect(await db.order.count()).toBe(1);
  expect(
    await db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 14000731n });
});

it('enforces the amount cap independently of the count cap', async () => {
  await db.dailyBudget.create({
    data: { day, targetCount: 20, targetAmount: 250n },
  });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => budget.reserve(day, 100n)),
  );
  expect(results.filter(Boolean)).toHaveLength(2);
  expect(
    await db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 2, reservedAmount: 200n });
});

it('refuses reservations when the UTC day has no budget', async () => {
  expect(await budget.reserve(day, 100n)).toBe(false);
  expect(await db.dailyBudget.count()).toBe(0);
});

it('uses the UTC calendar day and leaves other days unchanged', async () => {
  await db.dailyBudget.create({
    data: { day, targetCount: 1, targetAmount: 100n },
  });
  const tomorrow = new Date('2026-10-21');
  await db.dailyBudget.create({
    data: { day: tomorrow, targetCount: 1, targetAmount: 100n },
  });
  expect(await budget.reserve(new Date('2026-10-20T23:00:00Z'), 100n)).toBe(
    true,
  );
  expect(
    await db.dailyBudget.findUniqueOrThrow({ where: { day: tomorrow } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
});

it('restores count and amount capacity when a failed send releases its reservation', async () => {
  await db.dailyBudget.create({
    data: { day, targetCount: 1, targetAmount: 100n },
  });
  expect(await budget.reserve(day, 100n)).toBe(true);
  expect(await budget.reserve(day, 100n)).toBe(false);
  await budget.release(day, 100n);
  expect(
    await db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
  expect(await budget.reserve(day, 100n)).toBe(true);
});

it('does not release more count or amount than was reserved', async () => {
  await db.dailyBudget.create({
    data: { day, targetCount: 1, targetAmount: 100n },
  });
  await budget.release(day, 100n);
  await budget.reserve(day, 100n);
  await budget.release(day, 101n);
  expect(
    await db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 100n });
});

it('rolls back the reservation when order creation fails in the transaction', async () => {
  await db.dailyBudget.create({
    data: { day, targetCount: 1, targetAmount: 100n },
  });
  await expect(
    db.$transaction(async (tx) => {
      await new BudgetReservation(tx).reserve(day, 100n);
      throw new Error('Order creation failed');
    }),
  ).rejects.toThrow('Order creation failed');
  expect(
    await db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
});

it('rejects nonpositive reservations and releases without changing the budget', async () => {
  await db.dailyBudget.create({
    data: { day, targetCount: 1, targetAmount: 100n },
  });
  for (const amount of [0n, -1n]) {
    await expect(budget.reserve(day, amount)).rejects.toThrow(RangeError);
    await expect(budget.release(day, amount)).rejects.toThrow(RangeError);
  }
  expect(
    await db.dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 0, reservedAmount: 0n });
});
