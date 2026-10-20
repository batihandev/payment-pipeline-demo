import {
  fixture,
  clear,
  TrackerChain,
  log,
  now,
  options,
  order,
} from '../testing/fixtures';
import { Scanner } from './scanner';
let f: Awaited<ReturnType<typeof fixture>>;
let scanner: Scanner;
beforeAll(async () => {
  f = await fixture();
});
afterAll(async () => {
  await f.close();
});
beforeEach(async () => {
  await clear(f.db);
  f.chain = new TrackerChain();
  f.chain.logs = [log()];
  scanner = new Scanner(f.db, f.chain, options, () => now);
});
it('matches a transfer by its integer amount to a recent open order', async () => {
  const row = await order(f.db);
  await scanner.scanOnce();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    orderId: row.id,
    stage: 'received',
  });
});
it('stores an unmatched transfer without credit and records one incident across rescans', async () => {
  await scanner.scanOnce();
  await scanner.scanOnce();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    orderId: null,
    stage: 'received',
  });
  expect(await f.db.ledgerEntry.count()).toBe(0);
  expect(await f.db.incident.count({ where: { kind: 'unmatched' } })).toBe(1);
});
it('matches a late transfer to an expired order and records paid after expiry', async () => {
  const row = await order(f.db, {
    status: 'expired',
    expiresAt: new Date(now.getTime() - 60000),
  });
  await scanner.scanOnce();
  expect((await f.db.payment.findFirstOrThrow()).orderId).toBe(row.id);
  expect(
    (
      await f.db.incident.findFirstOrThrow({
        where: { kind: 'paid_after_expiry' },
      })
    ).whatHappened,
  ).toContain('paid after expiry');
});
it('does not match an order older than twenty-four hours', async () => {
  await order(f.db, { createdAt: new Date(now.getTime() - 86400001) });
  await scanner.scanOnce();
  expect((await f.db.payment.findFirstOrThrow()).orderId).toBeNull();
});
it('updates the buyer sent row in place when its transaction log arrives', async () => {
  const row = await order(f.db);
  const sent = await f.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: `sent:${row.id}`,
      orderId: row.id,
      chainId: options.chainId,
      amount: 100n,
      stage: 'sent',
      sentAt: now,
      transactionHash: log().txHash,
    },
  });
  await scanner.scanOnce();
  expect(await f.db.payment.count()).toBe(1);
  expect(
    await f.db.payment.findUniqueOrThrow({ where: { id: sent.id } }),
  ).toMatchObject({
    externalKey: `${options.chainId}:${log().txHash}:0`,
    orderId: row.id,
    stage: 'received',
    logIndex: 0,
    sentAt: now,
  });
});
it('uses normal amount matching when the buyer did not record the transaction', async () => {
  const row = await order(f.db, { transactionHash: log().txHash });
  await scanner.scanOnce();
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    orderId: row.id,
    stage: 'received',
  });
});
