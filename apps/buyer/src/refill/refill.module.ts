import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChainClient,
  type Address,
} from '../../../../libs/chain/src/chain-client';
import { PrismaService } from '../../../../libs/db/src';
import type { BuyerConfig } from '../buyer-config';
import { OrderSenderService } from '../sending/order-sender.service';
import { SendingModule } from '../sending/sending.module';
import { BUYER_ADDRESS, SHOP_ADDRESS } from '../sending/wallets';
import { RefillService } from './refill.service';

@Module({
  imports: [SendingModule],
  providers: [
    {
      provide: RefillService,
      inject: [
        PrismaService,
        ChainClient,
        OrderSenderService,
        BUYER_ADDRESS,
        SHOP_ADDRESS,
        ConfigService,
      ],
      useFactory: (
        db: PrismaService,
        chain: ChainClient,
        sender: OrderSenderService,
        buyer: Address,
        shop: Address,
        config: ConfigService<BuyerConfig, true>,
      ) =>
        new RefillService(db, chain, sender, buyer, shop, {
          below: config.get('REFILL_BELOW', { infer: true }),
          cooldownMs:
            config.get('REFILL_COOLDOWN_SECONDS', { infer: true }) * 1000,
        }),
    },
  ],
  exports: [RefillService],
})
export class RefillModule {}
