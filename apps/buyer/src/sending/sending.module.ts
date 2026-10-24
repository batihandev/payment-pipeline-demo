import { Module } from '@nestjs/common';
import { ChainModule } from '@app/chain/chain.module';
import { FundsService } from './funds.service';
import { OrderSenderService } from './order-sender.service';
import { RedisLock } from './redis-lock';

@Module({
  imports: [ChainModule.forRoot({ service: 'buyer' })],
  providers: [RedisLock, OrderSenderService, FundsService],
  exports: [OrderSenderService, FundsService, ChainModule],
})
export class SendingModule {}
