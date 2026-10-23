import {
  fixture,
  clear,
  TrackerChain,
  log,
  now,
  trackerConfig,
  order,
} from '../../testing/fixtures';
import { ScannerService } from './scanner.service';
import { ProgressService } from './progress.service';
let f: Awaited<ReturnType<typeof fixture>>;
let progress: ProgressService;
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
  await order(f.db);
  await new ScannerService(
    f.db,
    f.chain,
    trackerConfig(),
    () => now,
  ).scanOnce();
  progress = new ProgressService(
    f.db,
    new ScannerService(f.db, f.chain, trackerConfig(), () => now),
    () => now,
  );
});
it('settles a donation without an order or notice', async () => {
  await clear(f.db);
  f.chain.logs = [{ ...log(), from: `0x${'aa'.repeat(20)}` }];
  const scanner = new ScannerService(f.db, f.chain, trackerConfig(), () => now);
  await scanner.scanOnce();
  await new ProgressService(f.db, scanner, () => now).advance(15n);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'confirming',
    donation: true,
  });
  await new ProgressService(f.db, scanner, () => now).advance(20n);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'settled',
    settledAt: now,
  });
  expect(await f.db.ledgerEntry.findMany()).toMatchObject([{ amount: 100n }]);
  expect(await f.db.notice.count()).toBe(0);
});
it('computes confirmations from the pass head and waits for blocks on top', async () => {
  await progress.advance(19n);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'confirming',
    confirmations: 9,
    confirmingAt: now,
  });
  expect(await f.db.ledgerEntry.count()).toBe(0);
});
it('credits a payment once when settlement repeats concurrently', async () => {
  await Promise.all([progress.advance(20n), progress.advance(20n)]);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'settled',
    confirmations: 10,
    settledAt: now,
  });
  expect(await f.db.ledgerEntry.findMany()).toMatchObject([{ amount: 100n }]);
  expect((await f.db.order.findFirstOrThrow()).status).toBe('paid');
});
it('rolls back the settled stage and paid order when the ledger insert fails', async () => {
  await f.db.$executeRawUnsafe(
    'ALTER TABLE ledger_entries ADD CONSTRAINT reject_credit CHECK (amount < 0)',
  );
  try {
    await expect(progress.advance(20n)).rejects.toThrow();
    expect((await f.db.payment.findFirstOrThrow()).stage).toBe('received');
    expect((await f.db.order.findFirstOrThrow()).status).toBe('open');
  } finally {
    await f.db.$executeRawUnsafe(
      'ALTER TABLE ledger_entries DROP CONSTRAINT reject_credit',
    );
  }
});
it('never credits an unmatched transfer even above the confirmation threshold', async () => {
  await f.db.payment.updateMany({ data: { orderId: null } });
  await progress.advance(100n);
  expect((await f.db.payment.findFirstOrThrow()).stage).toBe('received');
  expect(await f.db.ledgerEntry.count()).toBe(0);
});
it('saves no confirmation-only events past the threshold', async () => {
  await progress.advance(20n);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'settled',
    confirmations: 10,
  });
  const events = await f.db.paymentEvent.count();
  await progress.advance(25n);
  await progress.advance(40n);
  expect(await f.db.paymentEvent.count()).toBe(events);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    confirmations: 10,
  });
});
