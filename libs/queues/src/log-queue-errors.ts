import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { errorFields } from '../../logging/src';

const logger = new Logger('Queue');

/**
 * Attaches a fixed connection-failure log line to each queue, so BullMQ does not print the
 * raw error. The line carries the error's name and code only.
 */
export function logQueueErrors<T extends Queue>(
  queues: T[],
  message: string,
): T[] {
  for (const queue of queues)
    queue.on('error', (error) => {
      logger.error(message, errorFields(error));
    });
  return queues;
}
