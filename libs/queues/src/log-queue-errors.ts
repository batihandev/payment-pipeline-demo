import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { Queue } from 'bullmq';

/** Attaches a fixed connection-failure log line to each queue, so BullMQ does not print the raw error. */
export function logQueueErrors<T extends Queue>(
  queues: T[],
  message: string,
): T[] {
  for (const queue of queues) queue.on('error', () => console.error(message));
  return queues;
}

export const QUEUE_ERROR_MESSAGE = Symbol('QUEUE_ERROR_MESSAGE');

/** Provides the line that queues log when their connection fails, to every module. */
@Global()
@Module({})
export class QueueErrorsModule {
  static forRoot(options: { message: string }): DynamicModule {
    return {
      module: QueueErrorsModule,
      providers: [{ provide: QUEUE_ERROR_MESSAGE, useValue: options.message }],
      exports: [QUEUE_ERROR_MESSAGE],
    };
  }
}
