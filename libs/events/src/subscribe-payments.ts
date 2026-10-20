import type { Redis } from 'ioredis';
import { paymentChannel } from './publish-payment';
export async function subscribePayments(
  redis: Redis,
  receive: (body: string) => void,
): Promise<() => Promise<void>> {
  const subscriber = redis.duplicate();
  subscriber.on('error', () =>
    console.error('Payment subscription connection failed.'),
  );
  subscriber.on('message', (channel, body) => {
    if (channel === paymentChannel) receive(body);
  });
  try {
    await subscriber.subscribe(paymentChannel);
  } catch (error) {
    subscriber.disconnect();
    throw error;
  }
  return async () => {
    await subscriber.quit();
  };
}
