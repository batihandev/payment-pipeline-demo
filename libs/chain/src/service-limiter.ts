import type { Redis } from 'ioredis';
import { RpcLimiter } from './rpc-limiter';
export const cooldownKey = (service: string) => `rpc-cooldown:${service}`;
export function serviceLimiter(
  redis: Redis,
  service: string,
  rate: number,
  cooldown: number,
) {
  return new RpcLimiter(rate, cooldown, Date.now, undefined, async () => {
    try {
      await redis.set(cooldownKey(service), '1', 'PX', cooldown);
    } catch {
      console.error('Could not report RPC cooldown.');
    }
  });
}
