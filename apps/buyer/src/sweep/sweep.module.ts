import { Module } from '@nestjs/common';
import {
  ChainClient,
  type Address,
} from '../../../../libs/chain/src/chain-client';
import { PrismaService } from '../../../../libs/db/src';
import { OrderSenderService } from '../sending/order-sender.service';
import { SendingModule } from '../sending/sending.module';
import { SHOP_ADDRESS } from '../sending/wallets';
import { SweepService } from './sweep.service';

@Module({
  imports: [SendingModule],
  providers: [
    {
      provide: SweepService,
      inject: [PrismaService, ChainClient, OrderSenderService, SHOP_ADDRESS],
      useFactory: (
        db: PrismaService,
        chain: ChainClient,
        sender: OrderSenderService,
        shop: Address,
      ) => new SweepService(db, chain, sender, shop),
    },
  ],
  exports: [SweepService],
})
export class SweepModule {}
