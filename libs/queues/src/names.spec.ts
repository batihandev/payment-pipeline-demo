import { expect, it } from 'vitest';
import { schedulerJobOptions } from './names';

it('keeps finished jobs and sets the priority when given', () => {
  expect(schedulerJobOptions({ priority: 5 })).toMatchObject({
    priority: 5,
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 5,
  });
  expect(schedulerJobOptions()).not.toHaveProperty('priority');
});

it('leaves out retries when asked', () => {
  expect(schedulerJobOptions({ retry: false })).toEqual({
    removeOnComplete: 100,
    removeOnFail: 100,
  });
});
