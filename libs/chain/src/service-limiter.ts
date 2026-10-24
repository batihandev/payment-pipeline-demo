import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { errorFields } from '@app/logging';
import { RpcLimiter } from './rpc-limiter';
const logger = new Logger('RpcLimiter');
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
    } catch (error) {
      logger.error('Could not report RPC cooldown.', errorFields(error));
    }
  });
}
