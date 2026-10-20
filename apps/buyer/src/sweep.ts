import { RpcError } from '../../../libs/chain/src/rpc-error';
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
  async run(day: Date, exhausted = false): Promise<void> {
    const id = utcDay(day).toISOString().slice(0, 10);
    const existing = await this.db.sweep.findUnique({ where: { id } });
    if (!existing) {
      let usdc: bigint;
      try {
        ({ usdc } = await this.chain.getBalances(this.shop));
      } catch (error) {
        await this.db.incident.create({
          data: {
            kind: 'sweep_failed',
            whatHappened: `Sweep ${id} could not read the shop balance (${error instanceof RpcError ? error.kind : 'transient'}).`,
            howHandled:
              'No transfer was signed. Retry the balance lookup with bounded backoff and the service cooldown; stop on a permanent failure.',
          },
        });
        throw error instanceof RpcError ? error : new RpcError('transient');
      }
      if (usdc === 0n) return;
      await this.db.sweep.upsert({
        where: { id },
        create: { id, amount: usdc },
        update: {},
      });
    }
    await this.sender.sendForSweep(id, exhausted);
  }
}
