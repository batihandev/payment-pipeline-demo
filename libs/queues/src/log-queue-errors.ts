import type { Queue } from 'bullmq';

/** The fixed line a queue connection failure logs; the underlying error is not printed. */
export const QUEUE_CONNECTION_FAILED = 'API queue connection failed.';

/** Attaches the connection-failure log line to each queue, so BullMQ does not print the raw error. */
export function logQueueErrors<T extends Queue>(queues: T[]): T[] {
  for (const queue of queues)
    queue.on('error', () => console.error(QUEUE_CONNECTION_FAILED));
  return queues;
}
