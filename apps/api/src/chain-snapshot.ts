import type {
  Address,
  ChainClient,
} from '../../../libs/chain/src/chain-client';
import { RpcError } from '../../../libs/chain/src/rpc-error';
import type { GasReading } from './test-purchases';

export type Balance = { native: bigint; usdc: bigint };
export type ChainReading = {
  head: bigint;
  balances: { buyer: Balance; shop: Balance };
  at: number;
};
/** Why the chain fields are missing: an RPC error kind, or `not_loaded` before the first read. */
export type ChainErrorCategory = RpcError['kind'] | 'not_loaded';
const MAX_AGE_MS = 10_000;

/**
 * One shared read of the head and both balances for every API route. Readers never wait on
 * RPC: they get the last reading and, when it is older than ten seconds, start one refresh
 * that concurrent readers share.
 */
export class ChainSnapshot {
  private reading: ChainReading | null = null;
  private error: RpcError['kind'] | null = null;
  private startedAt: number | null = null;
  private loading?: Promise<void>;
  constructor(
    private readonly chain: Pick<ChainClient, 'getHead' | 'getBalances'>,
    private readonly addresses: { buyer: Address; shop: Address },
    private readonly options: {
      now?: () => number;
      onRefresh?: (reading: ChainReading) => Promise<void>;
    } = {},
  ) {}
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  /** The last reading and, when the latest refresh failed, its error category. */
  current(): { reading: ChainReading | null; error: RpcError['kind'] | null } {
    if (this.startedAt === null || this.now() - this.startedAt >= MAX_AGE_MS)
      void this.refresh();
    return { reading: this.reading, error: this.error };
  }
  refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
  private async load(): Promise<void> {
    this.startedAt = this.now();
    let reading: ChainReading;
    try {
      const [head, buyer, shop] = await Promise.all([
        this.chain.getHead(),
        this.chain.getBalances(this.addresses.buyer),
        this.chain.getBalances(this.addresses.shop),
      ]);
      reading = {
        head: head.number,
        balances: { buyer, shop },
        at: this.now(),
      };
    } catch (error) {
      this.error = error instanceof RpcError ? error.kind : 'transient';
      return;
    }
    this.reading = reading;
    this.error = null;
    try {
      await this.options.onRefresh?.(reading);
    } catch {
      console.error('Could not record the chain reading.');
    }
  }
}

/** The buyer's gas balance as visitor admission reads it, without an RPC call. */
export function buyerGas(snapshot: ChainSnapshot): () => Promise<GasReading> {
  return async () => {
    const { reading } = snapshot.current();
    return reading
      ? { native: reading.balances.buyer.native, at: reading.at }
      : null;
  };
}
