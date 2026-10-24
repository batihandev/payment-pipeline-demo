import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import { JOBS, type BuyerJobData } from '@app/queues';
import type { BuyerConfig } from '../buyer-config';
import { BuyerProcessor } from './buyer.processor';
import { UpkeepProcessor } from './upkeep.processor';

const done = () => vi.fn(() => Promise.resolve(undefined));
const settings: Partial<BuyerConfig> = {
  MAX_IN_FLIGHT: 10,
  RETENTION_DAYS: 30,
};

function processors() {
  const sender = {
    inFlight: vi.fn(() => Promise.resolve(0)),
    sendForOrder: done(),
    checkUnseen: done(),
  };
  const buyer = new BuyerProcessor(
    {
      order: {
        findUnique: vi.fn(() => Promise.resolve({ rail: 'chain' })),
        findUniqueOrThrow: vi.fn(() => Promise.resolve({ rail: 'chain' })),
      },
      payment: { findFirst: vi.fn(() => Promise.resolve(null)) },
    } as never,
    {} as never,
    { visitor: vi.fn(() => Promise.resolve(null)) } as never,
    { recoverPending: done() } as never,
    { pace: done() } as never,
    sender as never,
    { charge: done() } as never,
    { covers: vi.fn(() => Promise.resolve(true)) } as never,
    { pruneOlderThan: vi.fn(() => Promise.resolve({})) } as never,
    { get: (key: keyof BuyerConfig) => settings[key] } as ConfigService<
      BuyerConfig,
      true
    >,
  );
  const upkeep = new UpkeepProcessor(
    { expireOrders: done() } as never,
    { run: done() } as never,
    sender as never,
    { run: done() } as never,
    { run: done() } as never,
  );
  return { buyer, upkeep };
}

const job = (name: string) =>
  ({
    name,
    data: { orderId: 'order-1' },
    attemptsMade: 0,
    opts: { attempts: 5 },
    timestamp: 0,
  }) as unknown as Job<BuyerJobData>;

const owners = [
  ...Object.values(JOBS.buyer).map((name) => [name, 'buyer'] as const),
  ...Object.values(JOBS.buyerUpkeep).map((name) => [name, 'upkeep'] as const),
];

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

it.each(owners)('routes %s to the %s processor only', async (name, owner) => {
  const { buyer, upkeep } = processors();
  const [handled, other] =
    owner === 'buyer' ? [buyer, upkeep] : [upkeep, buyer];
  await expect(handled.process(job(name))).resolves.toBeUndefined();
  await expect(other.process(job(name))).rejects.toThrow(UnrecoverableError);
});

it('rejects an unknown job name on both processors as unrecoverable', async () => {
  const { buyer, upkeep } = processors();
  for (const processor of [buyer, upkeep])
    await expect(processor.process(job('unknown-job'))).rejects.toThrow(
      new UnrecoverableError('Unknown buyer job'),
    );
});
