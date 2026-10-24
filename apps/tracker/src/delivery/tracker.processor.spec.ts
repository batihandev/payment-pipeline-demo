import { expect, it, vi } from 'vitest';
import { UnrecoverableError, type Job } from 'bullmq';
import { JOBS } from '@app/queues';
import { TrackerProcessor } from './tracker.processor';

const done = () => vi.fn(() => Promise.resolve(undefined));

function processor() {
  const delivery = { flush: done() };
  const gaps = { retryOnce: done() };
  return {
    delivery,
    gaps,
    processor: new TrackerProcessor(delivery as never, gaps as never),
  };
}

const job = (name: string) => ({ name, data: {} }) as unknown as Job;

it('flushes deliveries for the delivery job only', async () => {
  const { processor: tracker, delivery, gaps } = processor();
  await tracker.process(job(JOBS.tracker.deliverPayments));
  expect(delivery.flush).toHaveBeenCalledTimes(1);
  expect(gaps.retryOnce).not.toHaveBeenCalled();
});

it('retries one gap for the gap job only', async () => {
  const { processor: tracker, delivery, gaps } = processor();
  await tracker.process(job(JOBS.tracker.retryGap));
  expect(gaps.retryOnce).toHaveBeenCalledTimes(1);
  expect(delivery.flush).not.toHaveBeenCalled();
});

it('rejects an unknown job name as unrecoverable', async () => {
  const { processor: tracker } = processor();
  await expect(tracker.process(job('unknown-job'))).rejects.toThrow(
    new UnrecoverableError('Unknown tracker job'),
  );
});
