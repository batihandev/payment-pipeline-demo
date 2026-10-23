import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type {
  OrderQueueService,
  PurchasesService,
} from '../../../libs/orders/src';
import { VISITOR_PAUSED_SINCE } from '../../../libs/core/src/redis-keys';
import { utcDateKey } from '../../../libs/core/src/time';
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

export function registerTestPurchases(
  app: FastifyInstance,
  redis: Redis,
  db: PrismaClient,
  purchases: PurchasesService,
  orderQueue: OrderQueueService,
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
  // Waiting orders are ordered by (createdAt, id), so two created in the same millisecond
  // still get distinct positions.
  const position = async (order: { id: string; createdAt: Date }) =>
    1 +
    (await db.order.count({
      where: {
        ...waiting,
        OR: [
          { createdAt: { lt: order.createdAt } },
          { createdAt: order.createdAt, id: { lt: order.id } },
        ],
      },
    }));
  // Admissions run one at a time so the queue check and the new position stay exact.
  let turn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const result = turn.then(task);
    turn = result.catch(() => undefined);
    return result;
  };

  async function paused(now: Date): Promise<boolean> {
    const reading = await options.latestBuyerGas();
    return (
      reading !== null &&
      now.getTime() - reading.at <= staleReadingMs &&
      reading.native < limits.gasFloor
    );
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
        const day = utcDateKey(now);
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
        await orderQueue.queueSend(order.id, 'visitor');
        return reply
          .code(202)
          .send({ orderId: order.id, position: await position(order) });
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
      return { position: await position(order) };
    },
  );
}
