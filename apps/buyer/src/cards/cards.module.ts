import { Module } from '@nestjs/common';
import { OrdersModule } from '../../../../libs/orders/src';
import { StripeModule } from '../../../../libs/stripe/src';
import { CardSenderService } from './card-sender.service';

@Module({
  imports: [OrdersModule, StripeModule],
  providers: [CardSenderService],
  exports: [CardSenderService],
})
export class CardsModule {}
