import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrdersModule } from '@app/orders';
import type { ApiConfig } from '../common/api-config';
import { EventsModule } from '../events/events.module';
import { HealthModule } from '../health/health.module';
import { TestPurchasesController } from './test-purchases.controller';
import { TestPurchasesService } from './test-purchases.service';
import {
  VISITOR_LIMITS,
  VISITOR_PREFIX,
  type VisitorLimits,
} from './visitor-limits';

@Module({
  imports: [OrdersModule, HealthModule, EventsModule],
  controllers: [TestPurchasesController],
  providers: [
    TestPurchasesService,
    { provide: VISITOR_PREFIX, useValue: 'visitor-purchases' },
    {
      provide: VISITOR_LIMITS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiConfig, true>): VisitorLimits => ({
        perMinute: config.get('VISITOR_PER_MINUTE', { infer: true }),
        perDay: config.get('VISITOR_PER_DAY', { infer: true }),
        queueLimit: config.get('VISITOR_QUEUE_LIMIT', { infer: true }),
        dailyLimit: config.get('VISITOR_DAILY_LIMIT', { infer: true }),
        gasFloor: config.get('GAS_FLOOR', { infer: true }),
      }),
    },
  ],
})
export class TestPurchasesModule {}
