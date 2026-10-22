import type {
  Address,
  ChainClient,
} from '../../../libs/chain/src/chain-client';
import type { PrismaClient } from '../../../libs/db/src';
import { OrderSender } from './send-order';

export type RefillResult =
  'sent' | 'not-needed' | 'cooling-down' | 'shop-empty';
export type RefillOptions = {
  below: bigint;
  cooldownMs: number;
  now?: () => Date;
};

export class Refill {
  constructor(
    private readonly db: PrismaClient,
    private readonly chain: ChainClient,
    private readonly sender: OrderSender,
    private readonly buyer: Address,
    private readonly shop: Address,
    private readonly options: RefillOptions,
  ) {}
  async run(exhausted = false): Promise<RefillResult> {
    const now = (this.options.now ?? (() => new Date()))();
    const latest = await this.db.sweep.findFirst({
      where: { id: { startsWith: 'refill:' } },
      orderBy: { createdAt: 'desc' },
    });
    if (latest?.sendState === 'pending') {
      await this.sender.sendForSweep(latest.id, exhausted);
      return 'sent';
    }
    if (
      latest &&
      now.getTime() - latest.createdAt.getTime() < this.options.cooldownMs
    )
      return 'cooling-down';
    const buyer = await this.chain.getBalances(this.buyer);
    if (buyer.usdc >= this.options.below) return 'not-needed';
    const shop = await this.chain.getBalances(this.shop);
    if (shop.usdc === 0n || shop.native === 0n) return 'shop-empty';
    const id = `refill:${now.toISOString()}`;
    await this.db.sweep.create({
      data: { id, amount: shop.usdc, createdAt: now },
    });
    await this.sender.sendForSweep(id, exhausted);
    return 'sent';
  }
}
