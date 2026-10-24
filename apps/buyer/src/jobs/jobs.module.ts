import { Module } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OrdersModule } from '@app/orders';
import { QUEUES, logQueueErrors } from '@app/queues';
import { CardsModule } from '../cards/cards.module';
import { ExpiryModule } from '../expiry/expiry.module';
import { RefillModule } from '../refill/refill.module';
import { RetentionModule } from '../retention/retention.module';
import { SendingModule } from '../sending/sending.module';
import { SweepModule } from '../sweep/sweep.module';
import { BuyerProcessor } from './buyer.processor';
import { PaceService } from './pace.service';
import { SchedulesService } from './schedules.service';
import { UpkeepProcessor } from './upkeep.processor';

const UPKEEP_QUEUE_ERRORS = Symbol('UPKEEP_QUEUE_ERRORS');

@Module({
  imports: [
    OrdersModule,
    BullModule.registerQueue({ name: QUEUES.buyerUpkeep }),
    SendingModule,
    CardsModule,
    RefillModule,
    SweepModule,
    RetentionModule,
    ExpiryModule,
  ],
  providers: [
    PaceService,
    {
      provide: UPKEEP_QUEUE_ERRORS,
      inject: [getQueueToken(QUEUES.buyerUpkeep)],
      useFactory: (queue: Queue) =>
        logQueueErrors([queue], 'Buyer upkeep queue connection failed.'),
    },
    SchedulesService,
    BuyerProcessor,
    UpkeepProcessor,
  ],
})
export class JobsModule {}
