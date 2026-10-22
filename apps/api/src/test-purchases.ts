import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Purchases } from '../../buyer/src/purchases';
import type { BuyerJobs } from '../../buyer/src/jobs';
import type { PrismaClient } from '../../../libs/db/src';

export type GasReading = { native: bigint; at: number } | null;
export type VisitorLimits = {
  perMinute: number;
  perDay: number;
  queueLimit: number;
  dailyLimit: number;
  gasFloor: bigint;
};

const staleReadingMs = 5 * 60 * 1000;
const pausedSince = 'visitor-paused-since';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Returns {0} when admitted, {1, ms} when the minute limit is hit, {2} for the day limit.
const admit = `
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

export function registerTestPurchases(
  app: FastifyInstance,
  redis: Redis,
  db: PrismaClient,
  purchases: Purchases,
  jobs: BuyerJobs,
  options: {
    limits: VisitorLimits;
    latestBuyerGas: () => Promise<GasReading>;
    prefix?: string;
    now?: () => Date;
  },
): void {
  const prefix = options.prefix ?? 'visitor-purchases';
  const { limits } = options;
  const clock = () => options.now?.() ?? new Date();
  const waiting = {
    source: 'visitor',
    sendState: 'pending',
    status: 'open',
  } as const;
  // Admissions run one at a time so the queue check and the new position stay exact.
  let turn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const result = turn.then(task);
    turn = result.catch(() => undefined);
    return result;
  };

  async function paused(now: Date): Promise<boolean> {
    const reading = await options.latestBuyerGas();
    const low =
      reading !== null &&
      now.getTime() - reading.at <= staleReadingMs &&
      reading.native < limits.gasFloor;
    if (low) await redis.set(pausedSince, now.getTime(), 'NX');
    else await redis.del(pausedSince);
    return low;
  }

  app.post('/test-purchases', (request, reply) =>
    exclusive(async () => {
      const now = clock();
      let orderId: string | undefined;
      try {
        if (await paused(now)) return reply.code(503).send({ error: 'paused' });
        if ((await db.order.count({ where: waiting })) >= limits.queueLimit)
          return reply
            .code(429)
            .header('retry-after', 2)
            .send({ error: 'busy' });
        const ip = createHash('sha256').update(request.ip).digest('hex');
        const day = now.toISOString().slice(0, 10);
        const [verdict, wait] = (await redis.eval(
          admit,
          2,
          `${prefix}:min:${ip}`,
          `${prefix}:day:${ip}:${day}`,
          limits.perMinute,
          limits.perDay,
        )) as [number, number];
        if (verdict !== 0) {
          const midnight = Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
          );
          const seconds =
            verdict === 1
              ? Math.ceil(wait / 1000)
              : Math.ceil((midnight - now.getTime()) / 1000);
          return reply
            .code(429)
            .header('retry-after', Math.max(1, seconds))
            .send({ error: 'rate_limited' });
        }
        const order = await purchases.visitor(
          randomUUID(),
          now,
          limits.dailyLimit,
        );
        if (!order) return reply.code(409).send({ error: 'daily_limit' });
        orderId = order.id;
        await jobs.queueSend(order.id, 'visitor');
        const ahead = await db.order.count({
          where: { ...waiting, createdAt: { lt: order.createdAt } },
        });
        return reply.code(202).send({ orderId: order.id, position: ahead + 1 });
      } catch {
        return reply
          .code(503)
          .send(
            orderId
              ? { error: 'purchase_pending', orderId }
              : { error: 'purchases_unavailable' },
          );
      }
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/test-purchases/:id',
    async (request) => {
      const { id } = request.params;
      if (!uuid.test(id)) return { position: 0 };
      const order = await db.order.findFirst({ where: { id, ...waiting } });
      if (!order) return { position: 0 };
      const ahead = await db.order.count({
        where: { ...waiting, createdAt: { lt: order.createdAt } },
      });
      return { position: ahead + 1 };
    },
  );
}
