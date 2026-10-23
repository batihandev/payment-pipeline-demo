import { once } from 'node:events';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { testRedisUrl } from '../../config/testing/redis';
import { REDIS, RedisModule } from './redis.module';

it('quits Redis on shutdown', async () => {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [() => ({ REDIS_URL: testRedisUrl() })],
      }),
      RedisModule.forRoot({ service: 'Test' }),
    ],
  }).compile();
  const redis = module.get<Redis>(REDIS);
  expect(await redis.ping()).toBe('PONG');
  const quit = jest.spyOn(redis, 'quit');
  await module.close();
  expect(quit).toHaveBeenCalledTimes(1);
  if (redis.status !== 'end') await once(redis, 'end');
  expect(redis.status).toBe('end');
});

it('names the service in its connection-failure log line', async () => {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [() => ({ REDIS_URL: testRedisUrl() })],
      }),
      RedisModule.forRoot({ service: 'API' }),
    ],
  }).compile();
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    module.get<Redis>(REDIS).emit('error', new Error('refused'));
    expect(log).toHaveBeenCalledWith('API Redis connection failed.');
  } finally {
    log.mockRestore();
    await module.close();
  }
});
