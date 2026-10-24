import type { Redis } from 'ioredis';
import { VISITOR_PAUSED_SINCE } from '@app/core/redis-keys';

export type VisitorLimits = {
  perMinute: number;
  perDay: number;
  queueLimit: number;
  dailyLimit: number;
  gasFloor: bigint;
};

export const VISITOR_LIMITS = Symbol('VISITOR_LIMITS');
export const VISITOR_PREFIX = Symbol('VISITOR_PREFIX');

// Returns {0} when admitted, {1, ms} when the minute limit is hit, {2} for the day limit.
export const admit = `
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then
  return {1, redis.call('PTTL', KEYS[1])}
end
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then
  return {2, 0}
end
if redis.call('INCR', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], 60) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], 93600) end
return {0, 0}
`;

/**
 * Keeps the visitor pause marker in step with each chain reading: set when the buyer's gas
 * falls below the floor, cleared once it is topped up.
 */
export function recordGasPause(
  redis: Redis,
  gasFloor: bigint,
  now: () => number = Date.now,
): (reading: { balances: { buyer: { native: bigint } } }) => Promise<void> {
  return async (reading) => {
    if (reading.balances.buyer.native < gasFloor)
      await redis.set(VISITOR_PAUSED_SINCE, now(), 'NX');
    else await redis.del(VISITOR_PAUSED_SINCE);
  };
}
