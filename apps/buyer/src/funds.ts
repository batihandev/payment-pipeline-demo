import type {
  Address,
  ChainClient,
} from '../../../libs/chain/src/chain-client';
import type { PrismaClient } from '../../../libs/db/src';

export class BuyerFunds {
  private cached?: { usdc: bigint; at: number };
  constructor(
    private readonly db: PrismaClient,
    private readonly chain: Pick<ChainClient, 'getBalances'>,
    private readonly buyer: Address,
    private readonly ttlMs = 3000,
    private readonly now = Date.now,
  ) {}

  /**
   * Whether the buyer's USDC, less transfers still in flight, can pay the order.
   * A failed balance read counts as not covered, so the send is held and retried.
   */
  async covers(orderId: string): Promise<boolean> {
    const order = await this.db.order.findUnique({ where: { id: orderId } });
    if (
      !order ||
      order.sendState !== 'pending' ||
      order.signedTransaction !== null ||
      order.status === 'expired'
    )
      return true;
    const [usdc, inFlight] = await Promise.all([
      this.balance().catch(() => null),
      this.db.order.aggregate({
        _sum: { expectedAmount: true },
        where: { sendState: 'sent', payments: { some: { stage: 'sent' } } },
      }),
    ]);
    if (usdc === null) return false;
    return usdc - (inFlight._sum.expectedAmount ?? 0n) >= order.expectedAmount;
  }

  private async balance(): Promise<bigint> {
    const at = this.now();
    if (!this.cached || at - this.cached.at >= this.ttlMs)
      this.cached = {
        usdc: (await this.chain.getBalances(this.buyer)).usdc,
        at,
      };
    return this.cached.usdc;
  }
}
