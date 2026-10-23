import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChainClient,
  type Address,
} from '../../../../libs/chain/src/chain-client';
import { PrismaService } from '../../../../libs/db/src';
import type { BuyerConfig } from '../buyer-config';
import { OrderSenderService } from '../sending/order-sender.service';
import {
  BUYER_ADDRESS,
  SHOP_ADDRESS,
} from '../../../../libs/chain/src/wallet-addresses';

// The scheduler fires every cooldown and job starts jitter, so allow a short margin.
const COOLDOWN_TOLERANCE_MS = 1000;

export type RefillResult =
  'sent' | 'not-needed' | 'cooling-down' | 'shop-empty';
@Injectable()
export class RefillService {
  private readonly below: bigint;
  private readonly cooldownMs: number;

  constructor(
    private readonly db: PrismaService,
    private readonly chain: ChainClient,
    private readonly sender: OrderSenderService,
    @Inject(BUYER_ADDRESS) private readonly buyer: Address,
    @Inject(SHOP_ADDRESS) private readonly shop: Address,
    config: ConfigService<BuyerConfig, true>,
    @Optional() private readonly now = () => new Date(),
  ) {
    this.below = config.get('REFILL_BELOW', { infer: true });
    this.cooldownMs =
      config.get('REFILL_COOLDOWN_SECONDS', { infer: true }) * 1000;
  }
  async run(exhausted = false): Promise<RefillResult> {
    const now = this.now();
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
      now.getTime() - latest.createdAt.getTime() <
        this.cooldownMs - COOLDOWN_TOLERANCE_MS
    )
      return 'cooling-down';
    const buyer = await this.chain.getBalances(this.buyer);
    if (buyer.usdc >= this.below) return 'not-needed';
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
