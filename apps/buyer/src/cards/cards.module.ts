import { Module } from '@nestjs/common';
import { OrdersModule } from '../../../../libs/orders/src';
import { StripeModule } from '../../../../libs/stripe/src';
import { CardReconcilerService } from './card-reconciler.service';
import { CardSenderService } from './card-sender.service';

@Module({
  imports: [OrdersModule, StripeModule],
  providers: [CardSenderService, CardReconcilerService],
  exports: [CardSenderService, CardReconcilerService],
})
export class CardsModule {}
