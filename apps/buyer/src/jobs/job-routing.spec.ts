import { UnrecoverableError, type Job } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import { JOBS, type BuyerJobData } from '../../../../libs/queues/src';
import type { BuyerConfig } from '../buyer-config';
import { BuyerProcessor } from './buyer.processor';
import { UpkeepProcessor } from './upkeep.processor';

const done = () => jest.fn(async () => undefined);
const settings: Partial<BuyerConfig> = {
  MAX_IN_FLIGHT: 10,
  RETENTION_DAYS: 30,
};

function processors() {
  const sender = {
    inFlight: jest.fn(async () => 0),
    sendForOrder: done(),
    checkUnseen: done(),
  };
  const buyer = new BuyerProcessor(
    {
      order: {
        findUnique: jest.fn(async () => ({ rail: 'chain' })),
        findUniqueOrThrow: jest.fn(async () => ({ rail: 'chain' })),
      },
      payment: { findFirst: jest.fn(async () => null) },
    } as never,
    {} as never,
    { visitor: jest.fn(async () => null) } as never,
    { recoverPending: done() } as never,
    { pace: done() } as never,
    sender as never,
    { charge: done() } as never,
    { covers: jest.fn(async () => true) } as never,
    { pruneOlderThan: jest.fn(async () => ({})) } as never,
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
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
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
