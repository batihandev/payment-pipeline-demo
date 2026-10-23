import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { appConfig } from '../../../libs/config/src/config.module';
import { DatabaseModule } from '../../../libs/db/src';
import { QueueErrorsModule } from '../../../libs/queues/src';
import { RedisModule } from '../../../libs/redis/src';
import type { BuyerConfig } from './buyer-config';
import { JobsModule } from './jobs/jobs.module';

@Module({})
export class AppModule {
  /** Builds the app from a configuration the entry point has already validated. */
  static forRoot(config: BuyerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        appConfig(config),
        DatabaseModule,
        RedisModule.forRoot({ service: 'Buyer' }),
        QueueErrorsModule.forRoot({
          message: 'Buyer queue connection failed.',
        }),
        BullModule.forRoot({ connection: { url: config.REDIS_URL } }),
        JobsModule,
      ],
    };
  }
}
