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
import { TrackerPoller } from './polling';
let f: Awaited<ReturnType<typeof fixture>>;
let poller: TrackerPoller;
beforeAll(async () => {
  f = await fixture();
});
afterAll(async () => {
  await f.close();
});
beforeEach(async () => {
  await clear(f.db);
  f.chain = new TrackerChain();
  const scanner = new Scanner(f.db, f.chain, options, () => now);
  poller = new TrackerPoller(
    f.db,
    scanner,
    new PaymentProgress(f.db, scanner, () => now),
    { active: 2000, idle: 30000 },
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
  const scanner = new Scanner(f.db, f.chain, options, () => now);
  const low = new TrackerPoller(
    f.db,
    scanner,
    new PaymentProgress(f.db, scanner, () => now),
    { active: 2000, idle: 30000 },
    () => 0,
  );
  const high = new TrackerPoller(
    f.db,
    scanner,
    new PaymentProgress(f.db, scanner, () => now),
    { active: 2000, idle: 30000 },
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
