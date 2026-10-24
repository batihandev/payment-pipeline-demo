import { Redis } from 'ioredis';
import { testRedisUrl } from '@testing/config/redis';
import { ChainSnapshotService } from '../health/chain-snapshot.service';
import { recordGasPause } from './visitor-limits';

const floor = 200000000000000n;
let redis: Redis;
beforeAll(() => {
  redis = new Redis(testRedisUrl());
});
afterAll(async () => {
  await redis.quit();
});
afterEach(async () => {
  await redis.del('visitor-paused-since');
});

it('records the gas-floor pause on each chain refresh, without visitor clicks', async () => {
  const start = Date.parse('2026-10-20T12:00:00Z');
  let native = floor - 1n;
  let time = start;
  const snapshot = new ChainSnapshotService(
    {
      getHead: () => Promise.resolve({ number: 1n, hash: '0x01' }),
      getBalances: () => Promise.resolve({ native, usdc: 0n }),
    },
    { buyer: `0x${'11'.repeat(20)}`, shop: `0x${'22'.repeat(20)}` },
    {
      now: () => time,
      onRefresh: recordGasPause(redis, floor, () => time),
    },
  );
  await snapshot.refresh();
  expect(await redis.get('visitor-paused-since')).toBe(String(start));
  time += 10000;
  await snapshot.refresh();
  expect(await redis.get('visitor-paused-since')).toBe(String(start));
  native = floor;
  time += 10000;
  await snapshot.refresh();
  expect(await redis.get('visitor-paused-since')).toBeNull();
});
