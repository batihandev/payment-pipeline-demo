import { RpcError } from '../../../libs/chain/src/rpc-error';
import { fixture, clear, hash, log, now, options } from '../testing/fixtures';
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
  f.chain = new (
    f.chain.constructor as typeof import('../testing/fixtures').TrackerChain
  )();
  scanner = new Scanner(
    f.db,
    f.chain,
    options,
    () => now,
    async () => {},
    () => 0.5,
  );
});
it('stores duplicate and out-of-order logs once and advances to the range end', async () => {
  f.chain.logs = [log(19n), log(10n), log(19n)];
  await scanner.scanOnce();
  expect(await f.db.payment.count()).toBe(2);
  expect(await f.db.cursor.findFirstOrThrow()).toMatchObject({
    blockNumber: 20n,
    blockHash: hash(20n),
  });
  expect(await f.db.incident.count({ where: { kind: 'duplicate' } })).toBe(1);
});
it('bounds restart catch-up including overlap and spaces every RPC through the limiter', async () => {
  await f.db.cursor.create({
    data: {
      name: scanner.cursorName,
      blockNumber: 100n,
      blockHash: hash(100n),
    },
  });
  f.chain.head = 100000n;
  await scanner.scanOnce();
  expect(f.chain.ranges).toEqual([[95n, 594n]]);
  expect((await f.db.cursor.findFirstOrThrow()).blockNumber).toBe(594n);
  expect(
    f.chain.starts.every(
      (start, i, all) => i === 0 || start - (all[i - 1] ?? 0) >= 200,
    ),
  ).toBe(true);
});
it('re-reads the overlap without a duplicate incident', async () => {
  f.chain.logs = [log(19n)];
  await scanner.scanOnce();
  await scanner.scanOnce();
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.incident.count({ where: { kind: 'duplicate' } })).toBe(0);
});
it('records a duplicate for a log seen again outside the overlap', async () => {
  f.chain.logs = [log(19n)];
  await scanner.scanOnce();
  await f.db.$transaction((tx) =>
    scanner.storeLogs(tx, f.chain.logs, 10n, 20n),
  );
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.incident.count({ where: { kind: 'duplicate' } })).toBe(1);
});
it('steps back when the cursor block hash changes', async () => {
  await f.db.cursor.create({
    data: { name: scanner.cursorName, blockNumber: 20n, blockHash: hash(999n) },
  });
  await scanner.scanOnce();
  expect(f.chain.ranges[0]?.[0]).toBe(10n);
  expect(
    await f.db.incident.findFirst({ where: { kind: 'cursor_reorg' } }),
  ).not.toBeNull();
});
it('halves an oversized range until the provider accepts it', async () => {
  f.chain.head = 499n;
  f.chain.failure = (from, to) => {
    if (to - from + 1n > 125n) throw new RpcError('range_too_large');
  };
  await scanner.scanOnce();
  expect(f.chain.ranges).toEqual([
    [0n, 499n],
    [0n, 249n],
    [0n, 124n],
  ]);
  expect((await f.db.cursor.findFirstOrThrow()).blockNumber).toBe(124n);
});
it('persists a failed minimum range as a gap before moving the cursor past it', async () => {
  f.chain.head = 99n;
  f.chain.failure = () => {
    throw new RpcError('range_too_large');
  };
  await scanner.scanOnce();
  expect(await f.db.scanGap.findFirstOrThrow()).toMatchObject({
    fromBlock: 0n,
    toBlock: 9n,
    errorCategory: 'range_too_large',
    attempts: 1,
  });
  expect((await f.db.cursor.findFirstOrThrow()).blockNumber).toBe(9n);
});
it('backs off transient failures and stores an exhausted range as a gap', async () => {
  const waits: number[] = [];
  scanner = new Scanner(
    f.db,
    f.chain,
    options,
    () => now,
    async (ms) => {
      waits.push(ms);
    },
    () => 0.5,
  );
  f.chain.failure = () => {
    throw new RpcError('timeout');
  };
  await scanner.scanOnce();
  expect(waits).toEqual([750, 1500]);
  expect((await f.db.scanGap.findFirstOrThrow()).errorCategory).toBe('timeout');
});
it('does not retry a malformed request and records a handling note', async () => {
  f.chain.failure = () => {
    throw new RpcError('permanent');
  };
  await scanner.scanOnce();
  expect(f.chain.ranges).toHaveLength(1);
  expect((await f.db.scanGap.findFirstOrThrow()).errorCategory).toBe(
    'permanent',
  );
  expect((await f.db.incident.findFirstOrThrow()).howHandled).toContain('gap');
});
it('honors rate-limit cooldown before another RPC request', async () => {
  let first = true;
  f.chain.failure = () => {
    if (first) {
      first = false;
      throw new RpcError('rate_limit');
    }
  };
  await scanner.scanOnce();
  expect(
    f.chain.starts.some(
      (start, i, all) => i > 0 && start - (all[i - 1] ?? 0) >= 30000,
    ),
  ).toBe(true);
  expect(await f.db.scanGap.count()).toBe(0);
});
it('rolls back payments when the cursor cannot be saved', async () => {
  f.chain.logs = [log()];
  await f.db.cursor.create({
    data: { name: scanner.cursorName, blockNumber: 0n, blockHash: hash(0n) },
  });
  await f.db.$executeRawUnsafe(
    `CREATE FUNCTION reject_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cursor unavailable'; END $$`,
  );
  await f.db.$executeRawUnsafe(
    'CREATE TRIGGER reject_cursor BEFORE UPDATE ON cursors FOR EACH ROW EXECUTE FUNCTION reject_cursor()',
  );
  try {
    await expect(scanner.scanOnce()).rejects.toThrow();
    expect(await f.db.payment.count()).toBe(0);
    expect((await f.db.cursor.findFirstOrThrow()).blockNumber).toBe(0n);
  } finally {
    await f.db.$executeRawUnsafe('DROP TRIGGER reject_cursor ON cursors');
    await f.db.$executeRawUnsafe('DROP FUNCTION reject_cursor()');
  }
});
it('retains one open gap when an unchanged head repeats the same failed range', async () => {
  f.chain.failure = () => {
    throw new RpcError('permanent');
  };
  await scanner.scanOnce();
  await scanner.scanOnce();
  await scanner.scanOnce();
  const gaps = await f.db.scanGap.findMany();
  expect(
    gaps.filter((gap) => gap.fromBlock === 15n && gap.toBlock === 20n),
  ).toHaveLength(1);
});
it('rejects a minimum scan range that cannot advance beyond the configured overlap', () => {
  expect(() => new Scanner(f.db, f.chain, { ...options, minRange: 5 })).toThrow(
    'MIN_RANGE',
  );
});
it('stores one payment and one cursor when two scans overlap', async () => {
  f.chain.logs = [log()];
  await Promise.all([scanner.scanOnce(), scanner.scanOnce()]);
  expect(await f.db.payment.count()).toBe(1);
  expect((await f.db.cursor.findFirstOrThrow()).blockNumber).toBe(20n);
});

it('starts a fresh database near the head and saves the cursor', async () => {
  f.chain.head = 100000n;
  scanner = new Scanner(f.db, f.chain, { ...options, startBlock: undefined });
  await scanner.scanOnce();
  expect(f.chain.ranges).toEqual([[99995n, 100000n]]);
  expect((await f.db.cursor.findFirstOrThrow()).blockNumber).toBe(100000n);
});
it('uses START_BLOCK on a fresh database and retains an existing cursor on restart', async () => {
  f.chain.head = 100000n;
  scanner = new Scanner(f.db, f.chain, { ...options, startBlock: 80000n });
  await scanner.scanOnce();
  expect(f.chain.ranges).toEqual([[80000n, 80499n]]);
  await scanner.scanOnce();
  expect(f.chain.ranges[1]).toEqual([80494n, 80993n]);
});
