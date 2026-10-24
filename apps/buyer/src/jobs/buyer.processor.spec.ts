import { expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { JOBS, type BuyerJobData } from '@app/queues';
import type { BuyerConfig } from '../buyer-config';
import { BuyerProcessor } from './buyer.processor';

function setup(rail: 'chain' | 'card') {
  const sender = {
    inFlight: vi.fn(() => Promise.resolve(10)),
    sendForOrder: vi.fn(() => Promise.resolve(undefined)),
  };
  const funds = { covers: vi.fn(() => Promise.resolve(false)) };
  const cards = { charge: vi.fn(() => Promise.resolve(undefined)) };
  const payment = { id: 'payment-1', orderId: 'order-1' };
  const processor = new BuyerProcessor(
    {
      order: {
        findUnique: vi.fn(() => Promise.resolve({ rail })),
        findUniqueOrThrow: vi.fn(() => Promise.resolve({ rail })),
      },
      payment: { findFirst: vi.fn(() => Promise.resolve(payment)) },
    } as never,
    { publish: vi.fn(() => Promise.resolve(1)) } as never,
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
  const moveToDelayed = vi.fn(() => Promise.resolve(undefined));
  const job = {
    name: JOBS.buyer.sendOrder,
    data: { orderId: 'order-1' },
    attemptsMade: 0,
    opts: { attempts: 5 },
    moveToDelayed,
  } as unknown as Job<BuyerJobData>;
  return { processor, job, moveToDelayed, sender, funds, cards };
}

it('does not hold card orders for chain funds or the in-flight cap', async () => {
  const { processor, job, moveToDelayed, sender, funds, cards } = setup('card');
  await processor.process(job, 'token');
  expect(moveToDelayed).not.toHaveBeenCalled();
  expect(funds.covers).not.toHaveBeenCalled();
  expect(cards.charge).toHaveBeenCalledWith('order-1', false);
  expect(sender.sendForOrder).not.toHaveBeenCalled();
});

it('holds chain orders at the in-flight cap and sends them on chain', async () => {
  const { processor, job, moveToDelayed, sender, cards } = setup('chain');
  await expect(processor.process(job, 'token')).rejects.toThrow();
  expect(moveToDelayed).toHaveBeenCalled();
  expect(sender.sendForOrder).not.toHaveBeenCalled();
  expect(cards.charge).not.toHaveBeenCalled();
});
