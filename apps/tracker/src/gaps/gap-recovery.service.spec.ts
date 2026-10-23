import { RpcError } from '../../../../libs/chain/src/rpc-error';
import {
  fixture,
  clear,
  TrackerChain,
  log,
  now,
  options,
  order,
} from '../../testing/fixtures';
import { ScannerService } from '../scanning/scanner.service';
import { GapRecoveryService } from './gap-recovery.service';
let f: Awaited<ReturnType<typeof fixture>>;
let recovery: GapRecoveryService;
beforeAll(async () => {
  f = await fixture();
});
afterAll(async () => {
  await f.close();
});
beforeEach(async () => {
  await clear(f.db);
  f.chain = new TrackerChain();
  recovery = new GapRecoveryService(
    f.db,
    new ScannerService(
      f.db,
      f.chain,
      options,
      () => now,
      async () => {},
      () => 0.5,
    ),
    () => now,
  );
});
const gap = () =>
  f.db.scanGap.create({
    data: {
      fromBlock: 0n,
      toBlock: 20n,
      errorCategory: 'timeout',
      attempts: 1,
      nextRetryAt: now,
    },
  });
it('recovers gap payments atomically and records a recovery incident without moving the cursor', async () => {
  const row = await gap();
  await order(f.db);
  f.chain.logs = [log(), log()];
  await recovery.retryOnce();
  expect(
    await f.db.scanGap.findUniqueOrThrow({ where: { id: row.id } }),
  ).toMatchObject({ resolvedAt: now, attempts: 2 });
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.cursor.count()).toBe(0);
  expect(await f.db.incident.count({ where: { kind: 'gap_recovered' } })).toBe(
    1,
  );
});
it('stops automatic gap retries at the attempt cap while new scans keep progressing', async () => {
  await gap();
  f.chain.failure = () => {
    throw new RpcError('timeout');
  };
  await recovery.retryOnce();
  await f.db.scanGap.updateMany({ data: { nextRetryAt: now } });
  await recovery.retryOnce();
  await f.db.scanGap.updateMany({ data: { nextRetryAt: now } });
  await recovery.retryOnce();
  expect(await f.db.scanGap.findFirstOrThrow()).toMatchObject({
    attempts: 3,
    resolvedAt: null,
  });
  f.chain.failure = undefined;
  await new ScannerService(f.db, f.chain, options, () => now).scanOnce();
  expect((await f.db.cursor.findFirstOrThrow()).blockNumber).toBe(20n);
});
it('leaves future and permanently malformed gaps open without retrying them', async () => {
  await gap();
  await f.db.scanGap.updateMany({
    data: { nextRetryAt: new Date(now.getTime() + 1) },
  });
  await recovery.retryOnce();
  expect((await f.db.scanGap.findFirstOrThrow()).attempts).toBe(1);
  await f.db.scanGap.updateMany({
    data: { nextRetryAt: now, errorCategory: 'permanent' },
  });
  await recovery.retryOnce();
  expect((await f.db.scanGap.findFirstOrThrow()).attempts).toBe(1);
});
it('bounds each gap retry and retains the unscanned remainder after range halving', async () => {
  const row = await gap();
  await f.db.scanGap.update({ where: { id: row.id }, data: { toBlock: 999n } });
  f.chain.failure = (from, to) => {
    if (to - from + 1n > 125n) throw new RpcError('range_too_large');
  };
  await recovery.retryOnce();
  expect(await f.db.scanGap.findFirstOrThrow()).toMatchObject({
    fromBlock: 125n,
    toBlock: 999n,
    resolvedAt: null,
  });
  expect(f.chain.ranges).toEqual([
    [0n, 499n],
    [0n, 249n],
    [0n, 124n],
  ]);
});
it('rolls back recovered payments and resolution when storing a gap result fails', async () => {
  await gap();
  f.chain.logs = [log()];
  await f.db.$executeRawUnsafe(
    'ALTER TABLE scan_gaps ADD CONSTRAINT reject_resolution CHECK (resolved_at IS NULL)',
  );
  try {
    await expect(recovery.retryOnce()).rejects.toThrow();
    expect(await f.db.payment.count()).toBe(0);
    expect((await f.db.scanGap.findFirstOrThrow()).resolvedAt).toBeNull();
  } finally {
    await f.db.$executeRawUnsafe(
      'ALTER TABLE scan_gaps DROP CONSTRAINT reject_resolution',
    );
  }
});
