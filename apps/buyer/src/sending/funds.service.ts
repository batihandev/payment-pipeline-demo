import { Inject, Injectable, Optional } from '@nestjs/common';
import { ChainClient, type Address } from '@app/chain/chain-client';
import { PrismaService } from '@app/db';
import { BUYER_ADDRESS } from '@app/chain/wallet-addresses';

@Injectable()
export class FundsService {
  private cached?: { usdc: bigint; at: number };
  constructor(
    private readonly db: PrismaService,
    @Inject(ChainClient)
    private readonly chain: Pick<ChainClient, 'getBalances'>,
    @Inject(BUYER_ADDRESS) private readonly buyer: Address,
    @Optional() private readonly ttlMs = 3000,
    @Optional() private readonly now = Date.now,
  ) {}

  /**
   * Whether the buyer's USDC, less transfers still in flight, can pay the order.
   * A card order needs no chain funds.
   * A failed balance read counts as not covered, so the send is held and retried.
   */
  async covers(orderId: string): Promise<boolean> {
    const order = await this.db.order.findUnique({ where: { id: orderId } });
    if (
      !order ||
      order.rail === 'card' ||
      order.sendState !== 'pending' ||
      order.signedTransaction !== null ||
      order.status === 'expired'
    )
      return true;
    const [usdc, inFlight] = await Promise.all([
      this.balance().catch(() => null),
      this.db.order.aggregate({
        _sum: { expectedAmount: true },
        where: {
          rail: 'chain',
          sendState: 'sent',
          payments: { some: { stage: 'sent' } },
        },
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
