import { expect, it } from 'vitest';
import { UnrecoverableError, type Job } from 'bullmq';
import { TrackerProcessor } from './tracker.processor';

it('rejects an unknown job name as unrecoverable', async () => {
  const tracker = new TrackerProcessor({} as never, {} as never);
  const job = { name: 'unknown-job', data: {} } as unknown as Job;
  await expect(tracker.process(job)).rejects.toThrow(
    new UnrecoverableError('Unknown tracker job'),
  );
});
