import { Module } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ChainModule } from '../../../../libs/chain/src/chain.module';
import { ChainClient } from '../../../../libs/chain/src/chain-client';
import type { Address } from '../../../../libs/chain/src/chain-client';
import { OrdersModule } from '../../../../libs/orders/src';
import {
  QUEUES,
  QUEUE_ERROR_MESSAGE,
  logQueueErrors,
} from '../../../../libs/queues/src';
import { REDIS } from '../../../../libs/redis/src';
import type { ApiConfig } from '../common/api-config';
import { NOW, type Now } from '../common/clock.module';
import { recordGasPause } from '../test-purchases/visitor-limits';
import { CardRailService } from './card-rail.service';
import { ChainSnapshotService } from './chain-snapshot.service';
import { HEALTH_QUEUES, HealthService } from './health.service';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ChainModule.forRoot({ service: 'api' }),
    OrdersModule,
    BullModule.registerQueue(
      ...Object.values(QUEUES)
        .filter((name) => name !== QUEUES.buyer)
        .map((name) => ({ name })),
    ),
  ],
  controllers: [HealthController],
  providers: [
    HealthService,
    CardRailService,
    {
      provide: HEALTH_QUEUES,
      inject: [
        QUEUE_ERROR_MESSAGE,
        ...Object.values(QUEUES).map(getQueueToken),
      ],
      // OrdersModule logs the failures of the buyer queue it owns.
      useFactory: (message: string, ...queues: Queue[]) => {
        logQueueErrors(
          queues.filter((queue) => queue.name !== QUEUES.buyer),
          message,
        );
        return queues;
      },
    },
    {
      provide: ChainSnapshotService,
      inject: [ChainClient, ConfigService, REDIS, NOW],
      useFactory: (
        chain: ChainClient,
        config: ConfigService<ApiConfig, true>,
        redis: Redis,
        now: Now,
      ) => {
        const clock = () => now().getTime();
        return new ChainSnapshotService(
          chain,
          {
            buyer: config.get('BUYER_ADDRESS', { infer: true }) as Address,
            shop: config.get('SHOP_ADDRESS', { infer: true }) as Address,
          },
          {
            now: clock,
            onRefresh: recordGasPause(
              redis,
              config.get('GAS_FLOOR', { infer: true }),
              clock,
            ),
          },
        );
      },
    },
  ],
  exports: [ChainSnapshotService, CardRailService],
})
export class HealthModule {}
