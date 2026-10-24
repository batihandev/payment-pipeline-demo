import { RpcError } from '@app/chain/rpc-error';
import { Inject, Injectable } from '@nestjs/common';
import { ChainClient, type Address } from '@app/chain/chain-client';
import { PrismaService, recordIncident } from '@app/db';
import { OrderSenderService } from '../sending/order-sender.service';
import { SHOP_ADDRESS } from '@app/chain/wallet-addresses';
import { utcDateKey } from '@app/core/time';

@Injectable()
export class SweepService {
  constructor(
    private readonly db: PrismaService,
    private readonly chain: ChainClient,
    private readonly sender: OrderSenderService,
    @Inject(SHOP_ADDRESS) private readonly shop: Address,
  ) {}

  async run(day: Date, exhausted = false): Promise<void> {
    const id = utcDateKey(day);
    const existing = await this.db.sweep.findUnique({ where: { id } });
    if (!existing) {
      let usdc: bigint;
      try {
        ({ usdc } = await this.chain.getBalances(this.shop));
      } catch (error) {
        await recordIncident(this.db, {
          kind: 'sweep_failed',
          whatHappened: `Sweep ${id} could not read the shop balance (${error instanceof RpcError ? error.kind : 'transient'}).`,
          howHandled:
            'No transfer was signed. Retry the balance lookup with bounded backoff and the service cooldown; stop on a permanent failure.',
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
