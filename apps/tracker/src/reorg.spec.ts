import { handlePaymentReorg } from './payment-reorg';
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
it('continues confirming a payment that becomes final before its confirmation threshold', async () => {
  await progress.advance(11n, 10n);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    stage: 'confirming',
    final: true,
  });
  await progress.advance(20n, 10n);
  expect((await f.db.payment.findFirstOrThrow()).stage).toBe('settled');
  expect(await f.db.ledgerEntry.count()).toBe(1);
});
it('keeps the current confirmation count in events for a settled payment awaiting finality', async () => {
  await progress.advance(20n, 0n);
  await progress.advance(21n, 0n);
  const event = await f.db.paymentEvent.findFirstOrThrow({
    orderBy: { id: 'desc' },
  });
  expect(JSON.parse(event.body)).toMatchObject({
    stage: 'settled',
    confirmations: 11,
  });
});
it('keeps the payment identity when a re-mined transfer has a different log index', async () => {
  const original = await f.db.payment.findFirstOrThrow();
  f.chain.hashes.set(10n, hash(999n));
  await progress.advance(20n, 0n);
  f.chain.logs = [
    { ...log(), blockNumber: 21n, blockHash: hash(21n), logIndex: 7 },
  ];
  f.chain.head = 21n;
  await scanner.scanOnce();
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    id: original.id,
    stage: 'received',
    blockNumber: 21n,
    logIndex: 7,
    externalKey: `${options.chainId}:${log().txHash}:7`,
  });
});
it('holds a re-mined settled transaction for review without crediting its new log position', async () => {
  await progress.advance(20n, 0n);
  f.chain.hashes.set(10n, hash(999n));
  f.chain.logs = [
    { ...log(), blockNumber: 21n, blockHash: hash(21n), logIndex: 7 },
  ];
  f.chain.head = 31n;
  await scanner.scanOnce();
  await progress.advance(31n, 0n);
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.ledgerEntry.count()).toBe(1);
  expect(await f.db.incident.count({ where: { kind: 'settled_reorg' } })).toBe(
    1,
  );
});

it('preserves a credit when reorg processing loaded the payment before settlement committed', async () => {
  const observed = await f.db.payment.findFirstOrThrow();
  await progress.advance(20n, 0n);
  await f.db.$transaction((tx) => handlePaymentReorg(tx, observed, now));
  expect((await f.db.payment.findFirstOrThrow()).stage).toBe('settled');
  expect(await f.db.ledgerEntry.count()).toBe(1);
  expect(await f.db.incident.count({ where: { kind: 'settled_reorg' } })).toBe(
    1,
  );
});
it('re-reads a reorged donation as a donation', async () => {
  await clear(f.db);
  const donor = `0x${'aa'.repeat(20)}` as const;
  f.chain.logs = [{ ...log(), from: donor }];
  await scanner.scanOnce();
  const original = await f.db.payment.findFirstOrThrow();
  f.chain.hashes.set(10n, hash(999n));
  await progress.advance(20n, 0n);
  f.chain.logs = [
    {
      ...log(),
      blockNumber: 21n,
      blockHash: hash(21n),
      logIndex: 3,
      from: donor,
    },
  ];
  f.chain.head = 21n;
  await scanner.scanOnce();
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    id: original.id,
    donation: true,
    orderId: null,
    fromAddress: donor,
    stage: 'received',
    blockNumber: 21n,
  });
  expect(await f.db.incident.count({ where: { kind: 'unmatched' } })).toBe(0);
});
