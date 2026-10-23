import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

export const REDIS = Symbol('REDIS');
export const InjectRedis = () => Inject(REDIS);

const redisProvider = (name: string): Provider => ({
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<{ REDIS_URL: string }, true>) => {
    const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: 1,
    });
    redis.on('error', () => console.error(`${name} connection failed.`));
    return redis;
  },
});

@Global()
@Module({})
export class RedisModule implements OnModuleDestroy {
  /** Names the service in the connection-failure log line. */
  static forRoot(options: { service: string }): DynamicModule {
    return {
      module: RedisModule,
      providers: [redisProvider(`${options.service} Redis`)],
      exports: [REDIS],
    };
  }

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
