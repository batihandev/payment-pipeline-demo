import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import { ChainClient } from '@app/chain/chain-client';
import type { RpcError } from '@app/chain/rpc-error';
import { VISITOR_PAUSED_SINCE } from '@app/core/redis-keys';
import { testRedisUrl } from '@testing/config/redis';
import { testDatabase } from '@testing/db/database';
import { PrismaService, type PrismaClient } from '@app/db';
import { REDIS } from '@app/redis';
import { NOW } from '../src/common/clock.module';
import { ChainSnapshotService } from '../src/health/chain-snapshot.service';
import { createTestApp } from './app';

export const today = Date.parse('2026-10-22T12:00:00Z');

/**
 * Registers the hooks the read-route specs share: a test schema, a clock the test moves,
 * a scripted chain, and a fresh app (with a loaded chain snapshot) before each test.
 */
export function useReadApi() {
  let built: NestExpressApplication | undefined;
  const state = {
    time: today,
    chainCalls: [] as string[],
    headFailure: null as RpcError | null,
    queuePrefix: '',
    app: undefined as unknown as NestExpressApplication,
    database: undefined as unknown as Awaited<ReturnType<typeof testDatabase>>,
    redis: undefined as unknown as Redis,
    async rebuild(loadSnapshot = true): Promise<void> {
      await built?.close();
      state.app = built = await createTestApp({
        environment: { CONFIRMATIONS: '7' },
        queuePrefix: state.queuePrefix,
        override: (builder) => {
          builder
            .overrideProvider(PrismaService)
            .useValue(state.database.db)
            .overrideProvider(NOW)
            .useValue(() => new Date(state.time))
            .overrideProvider(ChainClient)
            .useValue({
              getHead: () => {
                state.chainCalls.push('getHead');
                if (state.headFailure) return Promise.reject(state.headFailure);
                return Promise.resolve({ number: 100n, hash: '0x01' });
              },
              getBalances: (address: string) => {
                state.chainCalls.push('getBalances');
                return Promise.resolve(
                  address === `0x${'11'.repeat(20)}`
                    ? { native: 1n, usdc: 20000000n }
                    : { native: 2000000000000000n, usdc: 2n },
                );
              },
            });
        },
      });
      if (loadSnapshot) {
        await state.app.get(ChainSnapshotService).refresh();
        // The scripted buyer is below the gas floor, so loading the snapshot sets the pause marker.
        await state.redis.del(VISITOR_PAUSED_SINCE);
      }
    },
    redisOf: () => state.app.get<Redis>(REDIS),
  };
  beforeAll(async () => {
    state.database = await testDatabase();
    state.redis = new Redis(testRedisUrl());
  });
  afterAll(async () => {
    await state.redis.quit();
    await state.database.close();
  });
  beforeEach(async () => {
    await state.database.db.$executeRawUnsafe(
      'TRUNCATE payments, orders, ledger_entries, incidents, cursors, scan_gaps CASCADE',
    );
    state.time = today;
    state.chainCalls = [];
    state.headFailure = null;
    state.queuePrefix = `api-test-${randomUUID()}`;
    await state.rebuild();
  });
  afterEach(async () => {
    await state.app.close();
    await state.redis.del(VISITOR_PAUSED_SINCE);
  });
  return state;
}

export const payment = (state: { database: { db: PrismaClient } }, data = {}) =>
  state.database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: randomUUID(),
      amount: 14000731n,
      transactionHash: '0x123',
      receivedAt: new Date('2026-10-20T12:00:00Z'),
      ...data,
    },
  });
