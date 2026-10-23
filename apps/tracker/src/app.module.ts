import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { appConfig } from '../../../libs/config/src/config.module';
import { trackerSchema } from '../../../libs/config/src';
import { DatabaseModule } from '../../../libs/db/src';
import {
  QUEUES,
  QUEUE_ERROR_MESSAGE,
  QueueErrorsModule,
  logQueueErrors,
} from '../../../libs/queues/src';
import { RedisModule } from '../../../libs/redis/src';
import { DeliveryModule } from './delivery/delivery.module';
import { NoticesModule } from './notices/notices.module';
import { PollingModule } from './polling/polling.module';
import { SchedulesService } from './schedules.service';
import type { TrackerConfig } from './tracker-config';

const TRACKER_QUEUE_ERRORS = Symbol('TRACKER_QUEUE_ERRORS');

@Module({})
export class AppModule {
  /** Reads and validates the environment when called, so it can be set up first. */
  static forRoot(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        appConfig(trackerSchema),
        DatabaseModule,
        RedisModule.forRoot({ service: 'Tracker' }),
        QueueErrorsModule.forRoot({
          message: 'Tracker queue connection failed.',
        }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<TrackerConfig, true>) => ({
            connection: { url: config.get('REDIS_URL', { infer: true }) },
          }),
        }),
        BullModule.registerQueue({ name: QUEUES.tracker }),
        DeliveryModule,
        NoticesModule,
        PollingModule,
      ],
      providers: [
        {
          provide: TRACKER_QUEUE_ERRORS,
          inject: [getQueueToken(QUEUES.tracker), QUEUE_ERROR_MESSAGE],
          useFactory: (queue: Queue, message: string) =>
            logQueueErrors([queue], message),
        },
        SchedulesService,
      ],
    };
  }
}
