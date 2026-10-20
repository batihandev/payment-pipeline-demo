import {
  fixture,
  clear,
  TrackerChain,
  hash,
  log,
  now,
  options,
  order,
} from '../testing/fixtures';
import { Scanner } from './scanner';
import { PaymentProgress } from './progress';
let f: Awaited<ReturnType<typeof fixture>>;
let scanner: Scanner;
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
  scanner = new Scanner(f.db, f.chain, options, () => now);
  await scanner.scanOnce();
  progress = new PaymentProgress(f.db, scanner, () => now);
});
it('drops an unsettled payment back when its block hash changes before settlement', async () => {
  f.chain.hashes.set(10n, hash(999n));
  await progress.advance(20n, 10n);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'sent',
    blockNumber: null,
    blockHash: null,
    confirmations: 0,
    final: false,
  });
  expect(await f.db.ledgerEntry.count()).toBe(0);
  expect(
    (await f.db.incident.findFirstOrThrow({ where: { kind: 'payment_reorg' } }))
      .howHandled,
  ).toContain('rescan');
});
it('treats a missing payment block as a reorg and never credits it', async () => {
  f.chain.hashes.set(10n, null);
  await progress.advance(20n, 10n);
  expect((await f.db.payment.findFirstOrThrow()).stage).toBe('sent');
  expect(await f.db.ledgerEntry.count()).toBe(0);
});
it('keeps a settled credit and records a reorg for manual review until final', async () => {
  await progress.advance(20n, 0n);
  f.chain.hashes.set(10n, hash(999n));
  await progress.advance(21n, 10n);
  await progress.advance(22n, 10n);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'settled',
    final: false,
  });
  expect(await f.db.ledgerEntry.count()).toBe(1);
  expect(await f.db.incident.count({ where: { kind: 'settled_reorg' } })).toBe(
    1,
  );
});
it('sets final only after a canonical payment block reaches the finalized tag', async () => {
  await progress.advance(20n, 9n);
  expect((await f.db.payment.findFirstOrThrow()).final).toBe(false);
  await progress.advance(20n, 10n);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    final: true,
    finalAt: now,
  });
  f.chain.hashes.set(10n, hash(999n));
  await progress.advance(30n, 20n);
  expect(await f.db.incident.count({ where: { kind: 'settled_reorg' } })).toBe(
    0,
  );
});
it('restores the same dropped payment when its transfer is mined again', async () => {
  const original = await f.db.payment.findFirstOrThrow();
  f.chain.hashes.set(10n, hash(999n));
  await progress.advance(20n, 0n);
  f.chain.logs = [{ ...log(), blockNumber: 21n, blockHash: hash(21n) }];
  f.chain.head = 21n;
  await scanner.scanOnce();
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    id: original.id,
    stage: 'received',
    blockNumber: 21n,
  });
});
