import {
  fixture,
  clear,
  TrackerChain,
  buyer,
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
const donor = `0x${'aa'.repeat(20)}` as const;
it('stores a transfer from another sender as a donation', async () => {
  const row = await order(f.db);
  f.chain.logs = [
    { ...log(), from: donor.toUpperCase().replace('0X', '0x') as typeof donor },
  ];
  await scanner.scanOnce();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    donation: true,
    orderId: null,
    fromAddress: donor,
    stage: 'received',
  });
  expect(await f.db.incident.count()).toBe(0);
  expect(
    (await f.db.order.findUniqueOrThrow({ where: { id: row.id } })).status,
  ).toBe('open');
});
it('does not credit a paid order from a copied amount', async () => {
  const row = await order(f.db, { status: 'paid' });
  f.chain.logs = [{ ...log(), from: donor }];
  await scanner.scanOnce();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    donation: true,
    orderId: null,
  });
  expect(
    (await f.db.order.findUniqueOrThrow({ where: { id: row.id } })).status,
  ).toBe('paid');
});
it('matches buyer transfers whatever the address case', async () => {
  const row = await order(f.db);
  const checksummed = `0x${'1A'.repeat(20)}`;
  f.chain.logs = [{ ...log(), from: `0x${'1a'.repeat(20)}` }];
  scanner = new Scanner(
    f.db,
    f.chain,
    { ...options, buyer: checksummed },
    () => now,
  );
  await scanner.scanOnce();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    orderId: row.id,
    donation: false,
  });
});
it('matches a checksummed log sender against a lower-case buyer address', async () => {
  const row = await order(f.db);
  f.chain.logs = [{ ...log(), from: `0x${'1A'.repeat(20)}` }];
  scanner = new Scanner(
    f.db,
    f.chain,
    { ...options, buyer: `0x${'1a'.repeat(20)}` },
    () => now,
  );
  await scanner.scanOnce();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    orderId: row.id,
    donation: false,
  });
});
it('keeps an unmatched buyer transfer as an unmatched incident', async () => {
  f.chain.logs = [{ ...log(), from: buyer }];
  await scanner.scanOnce();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    orderId: null,
    donation: false,
  });
  expect(await f.db.incident.count({ where: { kind: 'unmatched' } })).toBe(1);
});
