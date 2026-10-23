import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { OrderQueueService } from '../../../../libs/orders/src';
import {
  JOBS,
  QUEUES,
  schedulerJobOptions,
  type BuyerJobData,
} from '../../../../libs/queues/src';
import type { BuyerConfig } from '../buyer-config';

const UTC = 'UTC';

@Injectable()
export class SchedulesService implements OnModuleInit {
  private readonly refillEveryMs: number;

  constructor(
    @InjectQueue(QUEUES.buyer) private readonly queue: Queue<BuyerJobData>,
    @InjectQueue(QUEUES.buyerUpkeep)
    private readonly upkeepQueue: Queue<BuyerJobData>,
    private readonly orderQueue: OrderQueueService,
    config: ConfigService<BuyerConfig, true>,
  ) {
    this.refillEveryMs =
      config.get('REFILL_COOLDOWN_SECONDS', { infer: true }) * 1000;
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'buyer-minute',
      { pattern: '* * * * *', tz: UTC },
      {
        name: JOBS.buyer.paceMinute,
        data: {},
        opts: schedulerJobOptions({ priority: 5 }),
      },
    );
    await this.queue.upsertJobScheduler(
      'buyer-retention',
      { pattern: '30 3 * * *', tz: UTC },
      {
        name: JOBS.buyer.retention,
        data: {},
        opts: schedulerJobOptions({ priority: 10 }),
      },
    );
    for (const id of [
      'buyer-refill',
      'buyer-unseen',
      'buyer-expiry',
      'buyer-sweep',
    ])
      await this.queue.removeJobScheduler(id);
    await this.upkeepQueue.upsertJobScheduler(
      'buyer-refill',
      { every: this.refillEveryMs },
      {
        name: JOBS.buyerUpkeep.refillCheck,
        data: {},
        opts: schedulerJobOptions({ priority: 3 }),
      },
    );
    await this.upkeepQueue.upsertJobScheduler(
      'buyer-unseen',
      { every: 60_000 },
      {
        name: JOBS.buyerUpkeep.checkUnseen,
        data: {},
        opts: schedulerJobOptions({ priority: 4 }),
      },
    );
    await this.upkeepQueue.upsertJobScheduler(
      'buyer-expiry',
      { pattern: '* * * * *', tz: UTC },
      {
        name: JOBS.buyerUpkeep.expireOrders,
        data: {},
        opts: schedulerJobOptions({ priority: 5 }),
      },
    );
    await this.upkeepQueue.upsertJobScheduler(
      'buyer-sweep',
      { pattern: '0 3 * * *', tz: UTC },
      {
        name: JOBS.buyerUpkeep.nightlySweep,
        data: {},
        opts: schedulerJobOptions({ priority: 10 }),
      },
    );
    await this.orderQueue.recoverPending();
  }
}
