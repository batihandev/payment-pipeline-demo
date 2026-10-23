import { JOBS, QUEUES, schedulerJobOptions } from './names';

it('keeps finished jobs and sets the priority when given', () => {
  expect(schedulerJobOptions(5)).toMatchObject({
    priority: 5,
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 5,
  });
  expect(schedulerJobOptions()).not.toHaveProperty('priority');
});

it('leaves out retries when asked', () => {
  expect(schedulerJobOptions(undefined, false)).toEqual({
    removeOnComplete: 100,
    removeOnFail: 100,
  });
});

it('names every queue once', () => {
  expect(Object.values(QUEUES)).toEqual([
    'buyer',
    'buyer-upkeep',
    'tracker',
    'shop-notices',
  ]);
  expect(JOBS.buyer.sendOrder).toBe('send-order');
});
