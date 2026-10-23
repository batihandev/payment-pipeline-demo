import type { Queue } from 'bullmq';

/** Attaches a fixed connection-failure log line to each queue, so BullMQ does not print the raw error. */
export function logQueueErrors<T extends Queue>(
  queues: T[],
  message: string,
): T[] {
  for (const queue of queues) queue.on('error', () => console.error(message));
  return queues;
}
