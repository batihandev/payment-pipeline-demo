import { expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { ShopNoticesProcessor } from './shop-notices.processor';

const job = (attemptsMade: number, attempts: number) =>
  ({
    name: 'shop-notice',
    data: { paymentId: 'payment-1' },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job<{ paymentId: string }>;

it('sends the notice and marks only the last attempt as exhausted', async () => {
  const send = vi.fn(() => Promise.resolve(undefined));
  const processor = new ShopNoticesProcessor({ send } as never);
  await processor.process(job(0, 5));
  await processor.process(job(4, 5));
  expect(send.mock.calls).toEqual([
    ['payment-1', false],
    ['payment-1', true],
  ]);
});
