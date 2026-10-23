import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../../libs/db/testing/database';
import { FundsService } from './funds.service';

let database: Awaited<ReturnType<typeof testDatabase>>;
const buyer = `0x${'11'.repeat(20)}` as const;
const now = new Date('2026-10-20T12:00:00Z');
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.db.order.deleteMany();
});

function order(
  expectedAmount: bigint,
  extra: {
    sendState?: string;
    status?: 'open' | 'expired';
    signedTransaction?: string;
  } = {},
  stage?: 'sent' | 'received',
) {
  return database.db.order.create({
    data: {
      item: 'Duck',
      price: expectedAmount - 1n,
      expectedAmount,
      source: 'schedule',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1800000),
      ...extra,
      ...(stage && {
        payments: {
          create: {
            provider: 'chain',
            externalKey: `sent:${randomUUID()}`,
            amount: expectedAmount,
            stage,
          },
        },
      }),
    },
  });
}
function chainWith(usdc: bigint) {
  return { getBalances: jest.fn(async () => ({ native: 0n, usdc })) };
}

it('covers an order the balance can pay', async () => {
  const row = await order(1_000_000n);
  const funds = new FundsService(database.db, chainWith(1_000_000n), buyer);
  expect(await funds.covers(row.id)).toBe(true);
});

it('subtracts transfers still in flight', async () => {
  await order(1_500_000n, { sendState: 'sent' }, 'sent');
  await order(1_500_000n, { sendState: 'sent' }, 'received');
  const row = await order(1_000_000n);
  const funds = new FundsService(database.db, chainWith(2_000_000n), buyer);
  expect(await funds.covers(row.id)).toBe(false);
});

it('lets an expired order through to be closed', async () => {
  const row = await order(1_000_000n, { status: 'expired' });
  const chain = chainWith(0n);
  const funds = new FundsService(database.db, chain, buyer);
  expect(await funds.covers(row.id)).toBe(true);
  expect(chain.getBalances).not.toHaveBeenCalled();
});

it('lets an already-signed order through without reading the balance', async () => {
  const row = await order(1_000_000n, { signedTransaction: '0x01' });
  const chain = chainWith(0n);
  const funds = new FundsService(database.db, chain, buyer);
  expect(await funds.covers(row.id)).toBe(true);
  expect(chain.getBalances).not.toHaveBeenCalled();
});

it('holds the order when the balance read fails', async () => {
  const row = await order(1_000_000n);
  const chain = {
    getBalances: jest.fn(async () => {
      throw new Error('rpc down');
    }),
  };
  const funds = new FundsService(database.db, chain, buyer);
  expect(await funds.covers(row.id)).toBe(false);
});

it('reads the balance once per ttl', async () => {
  const row = await order(1_000_000n);
  const chain = chainWith(5_000_000n);
  let clock = 0;
  const funds = new FundsService(database.db, chain, buyer, 3000, () => clock);
  await funds.covers(row.id);
  clock = 2999;
  await funds.covers(row.id);
  expect(chain.getBalances).toHaveBeenCalledTimes(1);
  clock = 3000;
  await funds.covers(row.id);
  expect(chain.getBalances).toHaveBeenCalledTimes(2);
});
