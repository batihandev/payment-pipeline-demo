import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getQueueToken, getSharedConfigToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ChainClient } from '../../../libs/chain/src/chain-client';
import { restoreEnvironmentAfterAll } from '../../../libs/config/testing/environment';
import { trackerSchema, validateConfig } from '../../../libs/config/src';
import { testRedisUrl } from '../../../libs/config/testing/redis';
import { PrismaService } from '../../../libs/db/src';
import { QUEUES } from '../../../libs/queues/src';
import { REDIS } from '../../../libs/redis/src';
import { fixture, shop, buyer, TrackerChain } from '../testing/fixtures';
import { AppModule } from './app.module';
import { TrackerProcessor } from './delivery/tracker.processor';
import { ShopNoticesProcessor } from './notices/shop-notices.processor';
import { PollerService } from './polling/poller.service';

restoreEnvironmentAfterAll();

const prefix = `tracker-shutdown-test-${randomUUID()}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('stops the poll loop before closing workers, Redis and the database', async () => {
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    REDIS_URL: testRedisUrl(),
    CHAIN_ID: '84532',
    RPC_URL: 'https://example.com',
    USDC_ADDRESS: `0x${'33'.repeat(20)}`,
    BUYER_ADDRESS: buyer,
    SHOP_ADDRESS: shop,
    NOTICE_SECRET: 'test-notice-secret-01234567890123456789',
    SHOP_NOTICE_URL: 'http://127.0.0.1:9/shop/notices',
    ACTIVE_POLL_MS: '20',
    IDLE_POLL_MS: '20',
  });
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inPass = new Promise<void>((resolve) => (entered = resolve));
  let passes = 0;
  const order: string[] = [];
  const chain = new TrackerChain();
  const getHead = chain.getHead;
  chain.getHead = async () => {
    passes += 1;
    entered();
    await gate;
    return getHead();
  };
  const module = await Test.createTestingModule({
    imports: [AppModule.forRoot(validateConfig(trackerSchema, process.env))],
  })
    .overrideProvider(getSharedConfigToken())
    .useValue({ connection: { url: testRedisUrl() }, prefix })
    .overrideProvider(PrismaService)
    .useValue(
      new Proxy(f.db, {
        get: (target, name) =>
          name === 'onModuleDestroy'
            ? async () => {
                order.push('database');
              }
            : Reflect.get(target, name, target),
      }),
    )
    .overrideProvider(ChainClient)
    .useValue(chain)
    .compile();
  const tracker = module.get(TrackerProcessor);
  const notices = module.get(ShopNoticesProcessor);
  const redis = module.get<Redis>(REDIS);
  let closed = false;
  try {
    await module.init();
    await inPass;
    const recordEnd = <T extends object>(
      target: T,
      method: keyof T,
      name: string,
    ) => {
      const original = (target[method] as () => Promise<unknown>).bind(target);
      jest.spyOn(target, method as never).mockImplementation((async () => {
        const result = await original();
        order.push(name);
        return result;
      }) as never);
    };
    void module.get(PollerService)['loop']?.then(() => order.push('loop'));
    recordEnd(tracker.worker, 'close', 'tracker worker');
    recordEnd(notices.worker, 'close', 'notices worker');
    recordEnd(redis, 'quit', 'redis');
    expect(tracker.worker.isRunning()).toBe(true);
    expect(notices.worker.isRunning()).toBe(true);

    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      module
        .get<Queue>(getQueueToken(QUEUES.tracker), { strict: false })
        .emit('error', new Error('refused'));
      module
        .get<Queue>(getQueueToken(QUEUES.shopNotices), { strict: false })
        .emit('error', new Error('refused'));
      tracker.worker.emit('error', new Error('refused'));
      notices.worker.emit('error', new Error('refused'));
      expect(log.mock.calls).toEqual([
        ['Tracker queue connection failed.', { name: 'Error' }],
        ['Shop notice queue connection failed.', { name: 'Error' }],
        ['Tracker worker connection failed.', { name: 'Error' }],
        ['Shop notice worker connection failed.', { name: 'Error' }],
      ]);
    } finally {
      log.mockRestore();
    }

    const closing = module.close().then(() => (closed = true));
    await wait(300);
    expect(closed).toBe(false);
    release();
    await closing;

    expect(passes).toBe(1);
    expect(order[0]).toBe('loop');
    expect([...new Set(order.slice(1))].sort()).toEqual([
      'database',
      'notices worker',
      'redis',
      'tracker worker',
    ]);
    expect(tracker.worker.isRunning()).toBe(false);
    expect(notices.worker.isRunning()).toBe(false);
    expect(redis.status).toBe('end');
  } finally {
    release();
    if (!closed) await module.close();
    for (const name of [QUEUES.tracker, QUEUES.shopNotices]) {
      const probe = new Queue(name, {
        connection: { url: testRedisUrl() },
        prefix,
      });
      await probe.obliterate({ force: true });
      await probe.close();
    }
    await f.close();
  }
}, 30_000);
