import type { Redis } from 'ioredis';

/** Subscribes one connection to each channel in `receivers` and hands every message to its receiver. */
export async function subscribeEvents(
  redis: Redis,
  receivers: Record<string, (body: string) => void>,
): Promise<() => Promise<void>> {
  const subscriber = redis.duplicate();
  subscriber.on('error', () =>
    console.error('Event subscription connection failed.'),
  );
  subscriber.on('message', (channel, body) => receivers[channel]?.(body));
  try {
    await subscriber.subscribe(...Object.keys(receivers));
  } catch (error) {
    subscriber.disconnect();
    throw error;
  }
  return async () => {
    await subscriber.quit();
  };
}
