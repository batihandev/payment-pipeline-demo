import { randomUUID } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { InjectRedis } from '../../../../libs/redis/src';

@Injectable()
export class RedisLock {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Optional() private readonly prefix = 'buyer',
  ) {}
  async run<T>(wallet: string, operation: () => Promise<T>): Promise<T> {
    const key = `${this.prefix}:nonce:${wallet.toLowerCase()}`;
    const token = randomUUID();
    if ((await this.redis.set(key, token, 'PX', 30000, 'NX')) !== 'OK')
      throw new RpcError('transient');
    try {
      return await operation();
    } finally {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        token,
      );
    }
  }
}
