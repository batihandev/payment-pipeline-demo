import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getQueueToken, getSharedConfigToken } from '@nestjs/bullmq';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { generatePrivateKey } from 'viem/accounts';
import { buyerSchema, validateConfig } from '../../../libs/config/src';
import { testRedisUrl } from '../../../libs/config/testing/redis';
import { PrismaClient, PrismaService } from '../../../libs/db/src';
import { OrderQueueService } from '../../../libs/orders/src';
import { QUEUES } from '../../../libs/queues/src';
import { REDIS } from '../../../libs/redis/src';
import { AppModule } from './app.module';
import { ExpiryService } from './expiry/expiry.service';
import { BuyerProcessor } from './jobs/buyer.processor';
import { PaceService } from './jobs/pace.service';
import { UpkeepProcessor } from './jobs/upkeep.processor';
import { RefillService } from './refill/refill.service';
import { FundsService } from './sending/funds.service';
import { OrderSenderService } from './sending/order-sender.service';
import { SweepService } from './sweep/sweep.service';

const prefix = `buyer-shutdown-test-${randomUUID()}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('closes both workers and Redis on shutdown', async () => {
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    REDIS_URL: testRedisUrl(),
    CHAIN_ID: '84532',
    RPC_URL: 'https://example.com',
    USDC_ADDRESS: `0x${'33'.repeat(20)}`,
    BUYER_PRIVATE_KEY: generatePrivateKey(),
    SHOP_PRIVATE_KEY: generatePrivateKey(),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let orderId = '';
  let afterClose: Promise<unknown> | undefined;
  const sender = {
    inFlight: async () => 0,
    checkUnseen: async () => {},
    sendForOrder: async (id: string) => {
      if (id !== orderId) return;
      started();
      await gate;
      afterClose = Promise.all([
        module.get(PrismaService).order.count(),
        module.get<Redis>(REDIS).ping(),
      ]);
      await afterClose;
    },
  };
  const module = await Test.createTestingModule({
    imports: [AppModule.forRoot(validateConfig(buyerSchema, process.env))],
  })
    .overrideProvider(getSharedConfigToken())
    .useValue({ connection: { url: testRedisUrl() }, prefix })
    .overrideProvider(OrderSenderService)
    .useValue(sender)
    .overrideProvider(FundsService)
    .useValue({ covers: async () => true })
    .overrideProvider(PaceService)
    .useValue({ pace: async () => null })
    .overrideProvider(RefillService)
    .useValue({ run: async () => 'not-needed' })
    .overrideProvider(SweepService)
    .useValue({ run: async () => {} })
    .overrideProvider(ExpiryService)
    .useValue({ expireOrders: async () => 0 })
    .compile();
  const probe = new Queue(QUEUES.buyer, {
    connection: { url: testRedisUrl() },
    prefix,
  });
  const db = module.get(PrismaService);
  const buyer = module.get(BuyerProcessor);
  const upkeep = module.get(UpkeepProcessor);
  const redis = module.get<Redis>(REDIS);
  let order: { id: string } | undefined;
  let closed = false;
  try {
    await module.init();
    order = await db.order.create({
      data: {
        item: 'Duck',
        price: 99n,
        expectedAmount: 100n,
        source: 'schedule',
        expiresAt: new Date(Date.now() + 1800000),
      },
    });
    orderId = order.id;
    await module.get(OrderQueueService).queueSend(order.id, 'schedule');
    await running;
    expect(buyer.worker.isRunning()).toBe(true);
    expect(upkeep.worker.isRunning()).toBe(true);

    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      for (const name of Object.values(QUEUES).slice(0, 2))
        module
          .get<Queue>(getQueueToken(name), { strict: false })
          .emit('error', new Error('refused'));
      buyer.worker.emit('error', new Error('refused'));
      upkeep.worker.emit('error', new Error('refused'));
      expect(log.mock.calls).toEqual([
        ['Buyer queue connection failed.', { name: 'Error' }],
        ['Buyer upkeep queue connection failed.', { name: 'Error' }],
        ['Buyer worker connection failed.', { name: 'Error' }],
        ['Buyer upkeep worker connection failed.', { name: 'Error' }],
      ]);
    } finally {
      log.mockRestore();
    }

    const closing = module.close().then(() => (closed = true));
    await wait(500);
    expect(closed).toBe(false);
    release();
    await closing;

    await afterClose;
    expect(await (await probe.getJob(`send-${order.id}`))?.getState()).toBe(
      'completed',
    );
    expect(buyer.worker.isRunning()).toBe(false);
    expect(upkeep.worker.isRunning()).toBe(false);
    expect(redis.status).toBe('end');
  } finally {
    release();
    if (!closed) await module.close();
    if (order) {
      const admin = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.TEST_DATABASE_URL,
        }),
      });
      await admin.order.deleteMany({ where: { id: order.id } });
      await admin.$disconnect();
    }
    await probe.obliterate({ force: true });
    await probe.close();
  }
}, 30_000);
