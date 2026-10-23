import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../db/src';
import { QUEUES } from '../../queues/src';
import { OrderQueueService } from './order-queue.service';
import { PurchasesService, purchaseOptions } from './purchases.service';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.buyer })],
  providers: [
    {
      provide: PurchasesService,
      inject: [PrismaService, ConfigService],
      useFactory: (
        db: PrismaService,
        config: ConfigService<Parameters<typeof purchaseOptions>[0], true>,
      ) =>
        new PurchasesService(
          db,
          purchaseOptions({
            DAILY_COUNT_CAP: config.get('DAILY_COUNT_CAP', { infer: true }),
            DAILY_AMOUNT_CAP: config.get('DAILY_AMOUNT_CAP', { infer: true }),
            CHAIN_ID: config.get('CHAIN_ID', { infer: true }),
            ORDER_TTL_MINUTES: config.get('ORDER_TTL_MINUTES', { infer: true }),
            QUIET_START_HOUR_UTC: config.get('QUIET_START_HOUR_UTC', {
              infer: true,
            }),
            QUIET_END_HOUR_UTC: config.get('QUIET_END_HOUR_UTC', {
              infer: true,
            }),
          }),
        ),
    },
    OrderQueueService,
  ],
  exports: [PurchasesService, OrderQueueService],
})
export class OrdersModule {}
