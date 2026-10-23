import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { JOBS, type BuyerJobData } from '../../../../libs/queues/src';
import type { BuyerConfig } from '../buyer-config';
import { BuyerProcessor } from './buyer.processor';

function setup(rail: 'chain' | 'card') {
  const sender = {
    inFlight: jest.fn(async () => 10),
    sendForOrder: jest.fn(async () => undefined),
  };
  const funds = { covers: jest.fn(async () => false) };
  const cards = { charge: jest.fn(async () => undefined) };
  const payment = { id: 'payment-1', orderId: 'order-1' };
  const processor = new BuyerProcessor(
    {
      order: {
        findUnique: jest.fn(async () => ({ rail })),
        findUniqueOrThrow: jest.fn(async () => ({ rail })),
      },
      payment: { findFirst: jest.fn(async () => payment) },
    } as never,
    { publish: jest.fn(async () => 1) } as never,
    {} as never,
    {} as never,
    {} as never,
    sender as never,
    cards as never,
    funds as never,
    {} as never,
    {
      get: (key: keyof BuyerConfig) => (key === 'MAX_IN_FLIGHT' ? 10 : 30),
    } as ConfigService<BuyerConfig, true>,
  );
  const job = {
    name: JOBS.buyer.sendOrder,
    data: { orderId: 'order-1' },
    attemptsMade: 0,
    opts: { attempts: 5 },
    moveToDelayed: jest.fn(async () => undefined),
  } as unknown as Job<BuyerJobData>;
  return { processor, job, sender, funds, cards };
}

it('does not hold card orders for chain funds or the in-flight cap', async () => {
  const { processor, job, sender, funds, cards } = setup('card');
  await processor.process(job, 'token');
  expect(job.moveToDelayed).not.toHaveBeenCalled();
  expect(funds.covers).not.toHaveBeenCalled();
  expect(cards.charge).toHaveBeenCalledWith('order-1', false);
  expect(sender.sendForOrder).not.toHaveBeenCalled();
});

it('holds chain orders at the in-flight cap and sends them on chain', async () => {
  const { processor, job, sender, cards } = setup('chain');
  await expect(processor.process(job, 'token')).rejects.toThrow();
  expect(job.moveToDelayed).toHaveBeenCalled();
  expect(sender.sendForOrder).not.toHaveBeenCalled();
  expect(cards.charge).not.toHaveBeenCalled();
});
