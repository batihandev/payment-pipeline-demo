import { Module } from '@nestjs/common';
import { ChainModule } from '../../../../libs/chain/src/chain.module';
import { FundsService } from './funds.service';
import { OrderSenderService } from './order-sender.service';
import { RedisLock } from './redis-lock';
import { BUYER_ADDRESS, SHOP_ADDRESS, walletProviders } from './wallets';

@Module({
  imports: [ChainModule.forRoot({ service: 'buyer' })],
  providers: [...walletProviders, RedisLock, OrderSenderService, FundsService],
  exports: [
    OrderSenderService,
    FundsService,
    ChainModule,
    BUYER_ADDRESS,
    SHOP_ADDRESS,
  ],
})
export class SendingModule {}
