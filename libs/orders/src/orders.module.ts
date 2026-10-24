import { Module } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@app/db';
import type { Queue } from 'bullmq';
import { QUEUES, QUEUE_ERROR_MESSAGE, logQueueErrors } from '@app/queues';
import { CustomersService } from './customers.service';
import { OrderQueueService } from './order-queue.service';
import { PurchasesService, purchaseOptions } from './purchases.service';

const BUYER_QUEUE_ERRORS = Symbol('BUYER_QUEUE_ERRORS');

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.buyer })],
  providers: [
    {
      provide: PurchasesService,
      inject: [PrismaService, ConfigService, CustomersService],
      useFactory: (
        db: PrismaService,
        config: ConfigService<Parameters<typeof purchaseOptions>[0], true>,
        customers: CustomersService,
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
            STRIPE_SECRET_KEY: config.get('STRIPE_SECRET_KEY', { infer: true }),
          }),
          Math.random,
          customers,
        ),
    },
    CustomersService,
    OrderQueueService,
    {
      provide: BUYER_QUEUE_ERRORS,
      inject: [getQueueToken(QUEUES.buyer), QUEUE_ERROR_MESSAGE],
      useFactory: (queue: Queue, message: string) =>
        logQueueErrors([queue], message),
    },
  ],
  exports: [PurchasesService, CustomersService, OrderQueueService, BullModule],
})
export class OrdersModule {}
