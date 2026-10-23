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
      RedisModule,
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
