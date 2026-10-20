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
import { PaymentProgress } from './progress';
let f: Awaited<ReturnType<typeof fixture>>;
let progress: PaymentProgress;
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
  await new Scanner(f.db, f.chain, options, () => now).scanOnce();
  progress = new PaymentProgress(f.db, options, () => now);
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
