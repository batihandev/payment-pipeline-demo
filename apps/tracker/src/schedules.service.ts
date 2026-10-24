import type { OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { JOBS, QUEUES, schedulerJobOptions } from '@app/queues';

@Injectable()
export class SchedulesService implements OnModuleInit {
  constructor(@InjectQueue(QUEUES.tracker) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'tracker-gaps',
      { every: 10000 },
      {
        name: JOBS.tracker.retryGap,
        data: {},
        opts: schedulerJobOptions({ retry: false }),
      },
    );
    await this.queue.upsertJobScheduler(
      'tracker-delivery',
      { every: 2000 },
      {
        name: JOBS.tracker.deliverPayments,
        data: {},
        opts: schedulerJobOptions({ retry: false }),
      },
    );
  }
}
