import { testDatabase } from '../../../libs/db/testing/database';
import { pruneOlderThan } from './retention';
let database: Awaited<ReturnType<typeof testDatabase>>;
const now = new Date('2026-10-22T12:00:00Z');
const cutoff = new Date('2026-09-22T12:00:00Z');
const old = new Date('2026-09-01T12:00:00Z');
const recent = new Date('2026-10-10T12:00:00Z');
let key = 0;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  const { db } = database;
  await db.incident.deleteMany();
  await db.paymentEvent.deleteMany();
  await db.notice.deleteMany();
  await db.ledgerEntry.deleteMany();
  await db.payment.deleteMany();
  await db.order.deleteMany();
  await db.scanGap.deleteMany();
  await db.dailyBudget.deleteMany();
  await db.sweep.deleteMany();
});
function order(status: 'open' | 'paid' | 'expired', createdAt: Date) {
  return database.db.order.create({
    data: {
      item: 'Item',
      status,
      createdAt,
      expiresAt: createdAt,
      price: 100n,
      expectedAmount: 101n,
      source: 'schedule',
    },
  });
}
async function settled(
  orderId: string | null,
  settledAt: Date,
  extra: Record<string, unknown> = {},
) {
  const payment = await database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: `k${key++}`,
      orderId,
      amount: 101n,
      stage: 'notified',
      final: true,
      settledAt,
      receivedAt: settledAt,
      ...extra,
    },
  });
  await database.db.paymentEvent.create({
    data: { paymentId: payment.id, body: '{}' },
  });
  await database.db.notice.create({ data: { paymentId: payment.id } });
  await database.db.ledgerEntry.create({
    data: { paymentId: payment.id, amount: 101n },
  });
  return payment;
}
it('deletes month-old settled history', async () => {
  const { db } = database;
  const o = await order('paid', old);
  const p = await settled(o.id, old);
  await db.incident.create({
    data: {
      kind: 'x',
      whatHappened: 'a',
      howHandled: 'b',
      paymentId: p.id,
      createdAt: old,
    },
  });
  await db.scanGap.create({
    data: {
      fromBlock: 1n,
      toBlock: 2n,
      errorCategory: 'transient',
      nextRetryAt: old,
      resolvedAt: old,
    },
  });
  await db.dailyBudget.create({
    data: { day: old, targetCount: 1, targetAmount: 1n },
  });
  await db.sweep.create({
    data: { id: '2026-09-01', amount: 1n, sendState: 'sent', createdAt: old },
  });
  await db.sweep.create({
    data: {
      id: '2026-09-02',
      amount: 1n,
      sendState: 'pending',
      createdAt: old,
    },
  });
  const unmatched = await db.payment.create({
    data: {
      provider: 'chain',
      externalKey: 'u',
      amount: 5n,
      stage: 'received',
      final: true,
      receivedAt: old,
    },
  });
  const counts = await pruneOlderThan(db, cutoff);
  expect(counts).toEqual({
    events: 1,
    notices: 1,
    ledgerEntries: 1,
    incidents: 1,
    payments: 2,
    orders: 1,
    scanGaps: 1,
    dailyBudgets: 1,
    sweeps: 1,
  });
  expect(await db.payment.findUnique({ where: { id: unmatched.id } })).toBe(
    null,
  );
  expect((await db.sweep.findMany()).map(({ id }) => id)).toEqual([
    '2026-09-02',
  ]);
});
it('keeps open orders and unsettled payments however old', async () => {
  const { db } = database;
  const open = await order('open', old);
  const pending = await db.payment.create({
    data: {
      provider: 'chain',
      externalKey: 'p',
      orderId: open.id,
      amount: 1n,
      stage: 'confirming',
      receivedAt: old,
    },
  });
  const paidWithPending = await order('paid', old);
  await db.payment.create({
    data: {
      provider: 'chain',
      externalKey: 'q',
      orderId: paidWithPending.id,
      amount: 1n,
      stage: 'settled',
      settledAt: old,
    },
  });
  await db.scanGap.create({
    data: {
      fromBlock: 1n,
      toBlock: 2n,
      errorCategory: 'transient',
      nextRetryAt: old,
    },
  });
  await pruneOlderThan(db, cutoff);
  expect(await db.order.count()).toBe(2);
  expect(await db.payment.count()).toBe(2);
  expect(await db.payment.findUnique({ where: { id: pending.id } })).not.toBe(
    null,
  );
  expect(await db.scanGap.count()).toBe(1);
});
it('keeps the last 30 days', async () => {
  const { db } = database;
  const o = await order('paid', recent);
  await settled(o.id, recent);
  await db.dailyBudget.create({
    data: { day: recent, targetCount: 1, targetAmount: 1n },
  });
  await db.sweep.create({
    data: {
      id: '2026-10-10',
      amount: 1n,
      sendState: 'sent',
      createdAt: recent,
    },
  });
  const counts = await pruneOlderThan(db, new Date(now.getTime() - 30 * 864e5));
  expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  expect(await db.payment.count()).toBe(1);
  expect(await db.order.count()).toBe(1);
  expect(await db.paymentEvent.count()).toBe(1);
});
it("removes a payment's events before the payment", async () => {
  const { db } = database;
  const p = await settled(null, old);
  await db.paymentEvent.create({ data: { paymentId: p.id, body: '{"n":2}' } });
  await expect(pruneOlderThan(db, cutoff)).resolves.toMatchObject({
    events: 2,
    payments: 1,
  });
  expect(await db.paymentEvent.count()).toBe(0);
});
it('keeps a payment that a newer incident still references', async () => {
  const { db } = database;
  const p = await settled(null, old);
  await db.incident.create({
    data: {
      kind: 'x',
      whatHappened: 'a',
      howHandled: 'b',
      paymentId: p.id,
      createdAt: recent,
    },
  });
  await pruneOlderThan(db, cutoff);
  expect(await db.payment.count()).toBe(1);
  expect(await db.incident.count()).toBe(1);
});
it('keeps an old unmatched payment that is not final', async () => {
  const { db } = database;
  await db.payment.create({
    data: {
      provider: 'chain',
      externalKey: 'unmatched-open',
      amount: 5n,
      stage: 'received',
      receivedAt: new Date(now.getTime() - 40 * 864e5),
    },
  });
  await pruneOlderThan(db, cutoff);
  expect(await db.payment.count()).toBe(1);
});
it('keeps an old notified payment and its order until the payment is final', async () => {
  const { db } = database;
  const o = await order('paid', old);
  const p = await settled(o.id, old, { final: false });
  const counts = await pruneOlderThan(db, cutoff);
  expect(counts).toMatchObject({
    payments: 0,
    ledgerEntries: 0,
    notices: 0,
    events: 0,
    orders: 0,
  });
  expect(await db.payment.findUnique({ where: { id: p.id } })).not.toBeNull();
  expect(await db.order.count()).toBe(1);
  await db.payment.update({ where: { id: p.id }, data: { final: true } });
  await expect(pruneOlderThan(db, cutoff)).resolves.toMatchObject({
    payments: 1,
    orders: 1,
  });
});
