import { Module } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUES, logQueueErrors } from '../../../../libs/queues/src';
import { GapsModule } from '../gaps/gaps.module';
import { DeliveryService } from './delivery.service';
import { TrackerProcessor } from './tracker.processor';

const NOTICE_QUEUE_ERRORS = Symbol('NOTICE_QUEUE_ERRORS');

@Module({
  imports: [GapsModule, BullModule.registerQueue({ name: QUEUES.shopNotices })],
  providers: [
    DeliveryService,
    {
      provide: NOTICE_QUEUE_ERRORS,
      inject: [getQueueToken(QUEUES.shopNotices)],
      useFactory: (queue: Queue) =>
        logQueueErrors([queue], 'Shop notice queue connection failed.'),
    },
    TrackerProcessor,
  ],
})
export class DeliveryModule {}
