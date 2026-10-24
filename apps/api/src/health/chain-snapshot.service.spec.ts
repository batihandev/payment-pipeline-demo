import { ChainSnapshotService } from './chain-snapshot.service';
import { RpcError } from '@app/chain/rpc-error';

const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
function countingChain() {
  const calls: string[] = [];
  let release = () => {};
  let gate: Promise<void> = Promise.resolve();
  let failure: RpcError | null = null;
  let head = 100n;
  return {
    calls,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release();
    },
    fail(error: RpcError | null) {
      failure = error;
    },
    advance() {
      head++;
    },
    chain: {
      getHead: async () => {
        calls.push('getHead');
        await gate;
        if (failure) throw failure;
        return { number: head, hash: '0x01' as const };
      },
      getBalances: (address: `0x${string}`) => {
        calls.push(`getBalances:${address}`);
        return Promise.resolve(
          address === buyer
            ? { native: 5n, usdc: 6n }
            : { native: 7n, usdc: 8n },
        );
      },
    },
  };
}

it('shares one fetch across concurrent callers', async () => {
  const fake = countingChain();
  const snapshot = new ChainSnapshotService(fake.chain, { buyer, shop });
  fake.hold();
  const first = snapshot.refresh();
  const second = snapshot.refresh();
  expect(snapshot.current()).toEqual({ reading: null, error: null });
  fake.release();
  await Promise.all([first, second]);
  expect(fake.calls.filter((call) => call === 'getHead')).toHaveLength(1);
  expect(snapshot.current().reading).toMatchObject({
    head: 100n,
    balances: {
      buyer: { native: 5n, usdc: 6n },
      shop: { native: 7n, usdc: 8n },
    },
  });
});

it('serves a fresh snapshot without RPC calls and refreshes it after 10 seconds', async () => {
  const fake = countingChain();
  let time = 1_000_000;
  const snapshot = new ChainSnapshotService(
    fake.chain,
    { buyer, shop },
    { now: () => time },
  );
  await snapshot.refresh();
  const calls = fake.calls.length;
  time += 9999;
  expect(snapshot.current().reading?.head).toBe(100n);
  expect(fake.calls).toHaveLength(calls);
  fake.advance();
  time += 1;
  expect(snapshot.current().reading?.head).toBe(100n);
  await snapshot.refresh();
  expect(fake.calls.length).toBeGreaterThan(calls);
  expect(snapshot.current().reading).toMatchObject({ head: 101n, at: time });
});

it('keeps the last snapshot with its time when a refresh fails', async () => {
  const fake = countingChain();
  let time = 1_000_000;
  const snapshot = new ChainSnapshotService(
    fake.chain,
    { buyer, shop },
    { now: () => time },
  );
  await snapshot.refresh();
  fake.fail(new RpcError('rate_limit'));
  time += 10000;
  await snapshot.refresh();
  const { reading, error } = snapshot.current();
  expect(error).toBe('rate_limit');
  expect(reading).toMatchObject({ head: 100n, at: 1_000_000 });
  fake.fail(null);
  time += 10000;
  await snapshot.refresh();
  expect(snapshot.current().error).toBeNull();
});

it('reports a category, never the error message, when the first read fails', async () => {
  const fake = countingChain();
  fake.fail(new Error('https://secret.example/key') as RpcError);
  const snapshot = new ChainSnapshotService(fake.chain, { buyer, shop });
  await snapshot.refresh();
  expect(snapshot.current()).toEqual({ reading: null, error: 'transient' });
});

it('passes each new reading to the refresh hook', async () => {
  const fake = countingChain();
  const seen: bigint[] = [];
  const snapshot = new ChainSnapshotService(
    fake.chain,
    { buyer, shop },
    {
      onRefresh: (reading) => {
        seen.push(reading.balances.buyer.native);
        return Promise.resolve();
      },
    },
  );
  await snapshot.refresh();
  expect(seen).toEqual([5n]);
});
