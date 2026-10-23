import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { appConfig } from '../../../libs/config/src/config.module';
import { buyerSchema } from '../../../libs/config/src';
import { DatabaseModule } from '../../../libs/db/src';
import { QueueErrorsModule } from '../../../libs/queues/src';
import { RedisModule } from '../../../libs/redis/src';
import type { BuyerConfig } from './buyer-config';
import { JobsModule } from './jobs/jobs.module';

@Module({})
export class AppModule {
  /** Reads and validates the environment when called, so it can be set up first. */
  static forRoot(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        appConfig(buyerSchema),
        DatabaseModule,
        RedisModule.forRoot({ service: 'Buyer' }),
        QueueErrorsModule.forRoot({
          message: 'Buyer queue connection failed.',
        }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<BuyerConfig, true>) => ({
            connection: { url: config.get('REDIS_URL', { infer: true }) },
          }),
        }),
        JobsModule,
      ],
    };
  }
}
