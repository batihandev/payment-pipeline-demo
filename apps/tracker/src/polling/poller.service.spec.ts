import {
  fixture,
  clear,
  TrackerChain,
  log,
  now,
  trackerConfig,
  order,
} from '../../testing/fixtures';
import { ScannerService } from '../scanning/scanner.service';
import { ProgressService } from '../scanning/progress.service';
import { PollerService } from './poller.service';
let f: Awaited<ReturnType<typeof fixture>>;
let poller: PollerService;
beforeAll(async () => {
  f = await fixture();
});
afterAll(async () => {
  await f.close();
});
beforeEach(async () => {
  await clear(f.db);
  f.chain = new TrackerChain();
  const scanner = new ScannerService(f.db, f.chain, trackerConfig(), () => now);
  poller = new PollerService(
    f.db,
    scanner,
    new ProgressService(f.db, scanner, () => now),
    trackerConfig(),
    () => 0.5,
  );
});
it('uses the idle interval when no order or payment needs tracking', async () => {
  expect(await poller.pass()).toBe(30000);
});
it('polls every block while an order is open', async () => {
  await order(f.db);
  expect(await poller.pass()).toBe(2000);
});
it('keeps polling every block until a settled payment is final', async () => {
  await order(f.db);
  f.chain.logs = [log()];
  expect(await poller.pass()).toBe(2000);
  expect((await f.db.payment.findFirstOrThrow()).stage).toBe('settled');
  f.chain.finalized = 10n;
  expect(await poller.pass()).toBe(30000);
  expect((await f.db.payment.findFirstOrThrow()).final).toBe(true);
});
it('uses active polling during bounded catch-up without open orders', async () => {
  f.chain.head = 10000n;
  expect(await poller.pass()).toBe(2000);
});
it('adds small bounded jitter to poll intervals', async () => {
  const scanner = new ScannerService(f.db, f.chain, trackerConfig(), () => now);
  const low = new PollerService(
    f.db,
    scanner,
    new ProgressService(f.db, scanner, () => now),
    trackerConfig(),
    () => 0,
  );
  const high = new PollerService(
    f.db,
    scanner,
    new ProgressService(f.db, scanner, () => now),
    trackerConfig(),
    () => 1,
  );
  expect(await low.pass()).toBe(27000);
  expect(await high.pass()).toBe(33000);
});
it('uses one head and finalized snapshot for every payment in a pass', async () => {
  await order(f.db);
  f.chain.logs = [log()];
  let head = 20n;
  let finalized = 0n;
  f.chain.getHead = async () => ({ number: head++, hash: log().blockHash });
  f.chain.getFinalized = async () => finalized++;
  await poller.pass();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    confirmations: 10,
    final: false,
  });
});
it('keeps counting confirmations from the highest head seen when the RPC node lags', async () => {
  await order(f.db);
  f.chain.logs = [log(115n)];
  f.chain.head = 120n;
  await poller.pass();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    confirmations: 5,
  });
  f.chain.head = 110n;
  await poller.pass();
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    confirmations: 5,
  });
});
describe('poll loop', () => {
  const gate = () => {
    let open!: () => void;
    const closed = new Promise<void>((resolve) => (open = resolve));
    return { closed, open };
  };

  it('stops polling between passes on shutdown', async () => {
    const pass = jest.spyOn(poller, 'pass').mockResolvedValue(60_000);
    poller.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pass).toHaveBeenCalledTimes(1);
    await poller.onModuleDestroy();
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('lets the pass in flight finish before shutdown completes', async () => {
    const running = gate();
    const pass = jest.spyOn(poller, 'pass').mockImplementation(async () => {
      await running.closed;
      return 0;
    });
    poller.onApplicationBootstrap();
    let stopped = false;
    const stopping = poller.onModuleDestroy().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    running.open();
    await stopping;
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('records an incident and waits for the next poll when a pass fails', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const pass = jest
      .spyOn(poller, 'pass')
      .mockRejectedValue(new Error('rpc down'));
    poller.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await poller.onModuleDestroy();
    expect(pass).toHaveBeenCalledTimes(1);
    expect(
      await f.db.incident.count({ where: { kind: 'tracker_pass_failed' } }),
    ).toBe(1);
    expect(error).not.toHaveBeenCalled();
  });
});
