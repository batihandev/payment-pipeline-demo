import type {
  Address,
  ChainClient,
} from '../../../libs/chain/src/chain-client';
import type { PrismaClient } from '../../../libs/db/src';
import { OrderSender } from './send-order';
import { utcDay } from './purchases';

export class NightlySweep {
  constructor(
    private readonly db: PrismaClient,
    private readonly chain: ChainClient,
    private readonly sender: OrderSender,
    private readonly shop: Address,
  ) {}
  async run(day: Date): Promise<void> {
    const id = utcDay(day).toISOString().slice(0, 10);
    const existing = await this.db.sweep.findUnique({ where: { id } });
    if (!existing) {
      const { usdc } = await this.chain.getBalances(this.shop);
      if (usdc === 0n) return;
      await this.db.sweep.upsert({
        where: { id },
        create: { id, amount: usdc },
        update: {},
      });
    }
    await this.sender.sendForSweep(id);
  }
}
