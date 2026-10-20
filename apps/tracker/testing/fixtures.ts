import type {
  ChainClient,
  Hex,
  TransferLog,
} from '../../../libs/chain/src/chain-client';
import { RpcLimiter } from '../../../libs/chain/src/rpc-limiter';
import { testDatabase } from '../../../libs/db/testing/database';

export const shop = `0x${'22'.repeat(20)}` as const;
export const now = new Date('2026-10-20T12:00:00Z');
export const options = {
  chainId: 84532,
  shop,
  maxRange: 500,
  minRange: 10,
  rescanBlocks: 5,
  rpcAttempts: 3,
  gapAttempts: 3,
  confirmations: 10,
};
export const hash = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const log = (block = 10n, index = 0): TransferLog => ({
  txHash: hash(block + 1000n),
  logIndex: index,
  blockNumber: block,
  blockHash: hash(block),
  from: `0x${'11'.repeat(20)}`,
  to: shop,
  amount: 100n,
});
export class TrackerChain implements Pick<
  ChainClient,
  'getHead' | 'getFinalized' | 'getBlockHash' | 'getTransferLogs'
> {
  head = 20n;
  finalized = 0n;
  logs: TransferLog[] = [];
  hashes = new Map<bigint, Hex | null>();
  failure: ((from: bigint, to: bigint) => void) | undefined;
  time = 0;
  starts: number[] = [];
  ranges: [bigint, bigint][] = [];
  limiter = new RpcLimiter(
    5,
    30000,
    () => this.time,
    async (ms) => {
      this.time += ms;
    },
  );
  private request<T>(work: () => T): Promise<T> {
    return this.limiter.run(async () => {
      this.starts.push(this.time);
      return work();
    });
  }
  getHead = () =>
    this.request(() => ({ number: this.head, hash: hash(this.head) }));
  getFinalized = () => this.request(() => this.finalized);
  getBlockHash = (n: bigint) =>
    this.request(() =>
      this.hashes.has(n) ? (this.hashes.get(n) ?? null) : hash(n),
    );
  getTransferLogs = (from: bigint, to: bigint) =>
    this.request(() => {
      this.ranges.push([from, to]);
      this.failure?.(from, to);
      return this.logs.filter(
        (row) => row.blockNumber >= from && row.blockNumber <= to,
      );
    });
}
export async function fixture() {
  const database = await testDatabase();
  return { ...database, chain: new TrackerChain() };
}
export async function clear(db: Awaited<ReturnType<typeof fixture>>['db']) {
  await db.$executeRawUnsafe(
    'TRUNCATE payments, orders, ledger_entries, incidents, cursors, scan_gaps, notices CASCADE',
  );
}
