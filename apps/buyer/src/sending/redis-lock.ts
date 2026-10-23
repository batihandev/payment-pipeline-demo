import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RpcError } from '../../../../libs/chain/src/rpc-error';

export class RedisLock {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'buyer',
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
