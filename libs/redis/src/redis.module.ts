import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

export const REDIS = Symbol('REDIS');
export const InjectRedis = () => Inject(REDIS);

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ REDIS_URL: string }, true>) => {
        const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
          maxRetriesPerRequest: 1,
        });
        redis.on('error', () => console.error('Redis connection failed.'));
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
