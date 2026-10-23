import { Module, ValidationPipe, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { appConfig } from '../../../libs/config/src/config.module';
import { apiSchema } from '../../../libs/config/src';
import { DatabaseModule } from '../../../libs/db/src';
import { QueueErrorsModule } from '../../../libs/queues/src';
import { RedisModule } from '../../../libs/redis/src';
import type { ApiConfig } from './common/api-config';
import { ClockModule } from './common/clock.module';
import { ClientThrottlerGuard } from './common/client-throttler.guard';
import { GenericErrorFilter } from './common/generic-error.filter';
import { validationFailure } from './common/validation';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { IncidentsModule } from './incidents/incidents.module';
import { NoticesModule } from './notices/notices.module';
import { PaymentsModule } from './payments/payments.module';
import { PurchasesModule } from './purchases/purchases.module';
import { StatsModule } from './stats/stats.module';

@Module({})
export class AppModule {
  /** Reads and validates the environment when called, so it can be set up first. */
  static forRoot(): DynamicModule {
    return {
      module: AppModule,
      imports: [
        appConfig(apiSchema),
        DatabaseModule,
        RedisModule.forRoot({ service: 'API' }),
        QueueErrorsModule.forRoot({ message: 'API queue connection failed.' }),
        ClockModule,
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<ApiConfig, true>) => ({
            connection: { url: config.get('REDIS_URL', { infer: true }) },
          }),
        }),
        ThrottlerModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<ApiConfig, true>) => ({
            throttlers: [
              {
                ttl: 60_000,
                limit: config.get('API_REQUESTS_PER_MINUTE', { infer: true }),
              },
            ],
            // One budget per address across all routes.
            generateKey: (_context, tracker, name) => `${name}:${tracker}`,
          }),
        }),
        PaymentsModule,
        IncidentsModule,
        StatsModule,
        HealthModule,
        EventsModule,
        PurchasesModule,
        NoticesModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ClientThrottlerGuard },
        { provide: APP_FILTER, useClass: GenericErrorFilter },
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            validationError: { target: true },
            exceptionFactory: validationFailure,
          }),
        },
      ],
    };
  }
}
