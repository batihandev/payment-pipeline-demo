import { Module } from '@nestjs/common';
import { OrdersModule } from '@app/orders';
import { StripeModule } from '@app/stripe';
import { CardReconcilerService } from './card-reconciler.service';
import { CardSenderService } from './card-sender.service';

@Module({
  imports: [OrdersModule, StripeModule],
  providers: [CardSenderService, CardReconcilerService],
  exports: [CardSenderService, CardReconcilerService],
})
export class CardsModule {}
