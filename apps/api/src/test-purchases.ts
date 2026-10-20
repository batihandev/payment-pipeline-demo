import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Purchases } from '../../buyer/src/purchases';
import type { BuyerJobs } from '../../buyer/src/jobs';
const admit = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= 3 then return {1, redis.call('PTTL', KEYS[1])} end
local cooldown = redis.call('PTTL', KEYS[2])
if cooldown > 0 then return {2, cooldown} end
if redis.call('INCR', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], 600000) end
redis.call('SET', KEYS[2], '1', 'PX', 5000)
return {0, 0}
`;
export function registerTestPurchases(
  app: FastifyInstance,
  redis: Redis,
  purchases: Purchases,
  jobs: BuyerJobs,
  options: { prefix?: string; now?: () => Date } = {},
): void {
  app.post('/test-purchases', async (request, reply) => {
    const prefix = options.prefix ?? 'visitor-purchases';
    const ip = createHash('sha256').update(request.ip).digest('hex');
    let orderId: string | undefined;
    try {
      const result = (await redis.eval(
        admit,
        2,
        `${prefix}:ip:${ip}`,
        `${prefix}:cooldown`,
      )) as [number, number];
      if (result[0] !== 0)
        return reply
          .code(429)
          .header('retry-after', Math.max(1, Math.ceil(result[1] / 1000)))
          .send({ error: result[0] === 1 ? 'rate_limited' : 'cooldown' });
      const order = await purchases.visitor(
        randomUUID(),
        options.now?.() ?? new Date(),
      );
      if (!order) return reply.code(409).send({ error: 'budget_spent' });
      orderId = order.id;
      await jobs.queueSend(order.id, 'visitor');
      return reply.code(202).send({ orderId: order.id });
    } catch {
      return reply
        .code(503)
        .send(
          orderId
            ? { error: 'purchase_pending', orderId }
            : { error: 'purchases_unavailable' },
        );
    }
  });
}
