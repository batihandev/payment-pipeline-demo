import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import type { apiSchema } from '../../../libs/config/src';
import type { PrismaClient } from '../../../libs/db/src';
import { publicPayment } from '../../../libs/events/src/public-payment';
import { cooldownKey } from '../../../libs/chain/src/service-limiter';
import type {
  Balance,
  ChainErrorCategory,
  ChainSnapshot,
} from './chain-snapshot';
export type ApiConfig = z.output<typeof apiSchema>;
export type ReadState = {
  snapshot: Pick<ChainSnapshot, 'current'>;
  redis: Redis;
  queues: Record<string, Queue>;
  now?: () => number;
};
export function json(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  );
}
const limitQuery = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
} as const;
export function registerReads(
  app: FastifyInstance,
  db: PrismaClient,
  config: ApiConfig,
  state: ReadState,
): void {
  app.get<{ Querystring: { limit: number } }>(
    '/payments',
    { schema: { querystring: limitQuery } },
    async (request) => {
      const ids = await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM payments WHERE NOT (donation AND amount < ${config.DONATION_MIN}) ORDER BY COALESCE(sent_at, received_at) DESC NULLS LAST, id DESC LIMIT ${request.query.limit}`;
      const rows = await db.payment.findMany({
        where: { id: { in: ids.map((row) => row.id) } },
        include: {
          order: {
            select: {
              id: true,
              item: true,
              price: true,
              expectedAmount: true,
              status: true,
              source: true,
              createdAt: true,
              expiresAt: true,
            },
          },
        },
      });
      return json(
        rows
          .sort(
            (a, b) =>
              ids.findIndex((row) => row.id === a.id) -
              ids.findIndex((row) => row.id === b.id),
          )
          .map((row) => ({
            ...publicPayment(row),
            order: row.order,
            explorerUrl: row.transactionHash
              ? `${config.BLOCK_EXPLORER_URL.replace(/\/$/, '')}/tx/${row.transactionHash}`
              : null,
          })),
      );
    },
  );
  app.get<{ Querystring: { limit: number } }>(
    '/incidents',
    { schema: { querystring: limitQuery } },
    async (request) =>
      json(
        await db.incident.findMany({
          take: request.query.limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      ),
  );
  const cached = (ttl: number, compute: () => Promise<unknown>) => {
    let cache: { expires: number; value: unknown } | undefined;
    let loading: Promise<unknown> | undefined;
    return async () => {
      const now = state.now ?? Date.now;
      if (cache && now() < cache.expires) return cache.value;
      loading ??= (async () => {
        const value = await compute();
        cache = { expires: now() + ttl, value };
        return value;
      })();
      try {
        return await loading;
      } finally {
        loading = undefined;
      }
    };
  };
  const dayMs = 86400000;
  const utcDayStart = () => {
    const at = (state.now ?? Date.now)();
    return new Date(at - (at % dayMs));
  };
  app.get(
    '/stats',
    cached(5000, async () => {
      const from = utcDayStart();
      const to = new Date(from.getTime() + dayMs);
      const [rows, duplicatesSkipped, failuresRecovered] = await Promise.all([
        db.$queryRaw<
          { settledCount: bigint; averageTimeToSettleMs: number | null }[]
        >`SELECT COUNT(*)::bigint AS "settledCount", AVG(EXTRACT(EPOCH FROM (p.settled_at - COALESCE(p.sent_at, p.received_at))) * 1000)::float8 AS "averageTimeToSettleMs" FROM ledger_entries l JOIN payments p ON p.id = l.payment_id WHERE p.settled_at >= ${from} AND p.settled_at < ${to} AND NOT (p.donation AND p.amount < ${config.DONATION_MIN})`,
        db.incident.count({
          where: { kind: 'duplicate', createdAt: { gte: from, lt: to } },
        }),
        db.incident.count({
          where: { kind: 'gap_recovered', createdAt: { gte: from, lt: to } },
        }),
      ]);
      return {
        settledCount: Number(rows[0]?.settledCount ?? 0),
        averageTimeToSettleMs: rows[0]?.averageTimeToSettleMs ?? null,
        duplicatesSkipped,
        failuresRecovered,
      };
    }),
  );
  app.get(
    '/stats/daily',
    cached(60000, async () => {
      const to = new Date(utcDayStart().getTime() + dayMs);
      const from = new Date(to.getTime() - config.RETENTION_DAYS * dayMs);
      const rows = await db.$queryRaw<
        {
          day: string;
          settled: bigint;
          scheduled: bigint;
          visitor: bigint;
          averageTimeToSettleMs: number | null;
        }[]
      >`SELECT to_char(p.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS settled, COUNT(*) FILTER (WHERE o.source = 'schedule')::bigint AS scheduled, COUNT(*) FILTER (WHERE o.source = 'visitor')::bigint AS visitor, AVG(EXTRACT(EPOCH FROM (p.settled_at - COALESCE(p.sent_at, p.received_at))) * 1000)::float8 AS "averageTimeToSettleMs" FROM ledger_entries l JOIN payments p ON p.id = l.payment_id LEFT JOIN orders o ON o.id = p.order_id WHERE p.settled_at >= ${from} AND p.settled_at < ${to} AND NOT (p.donation AND p.amount < ${config.DONATION_MIN}) GROUP BY 1`;
      const byDay = new Map(rows.map((row) => [row.day, row]));
      return Array.from({ length: config.RETENTION_DAYS }, (_, index) => {
        const day = new Date(from.getTime() + index * dayMs)
          .toISOString()
          .slice(0, 10);
        const row = byDay.get(day);
        return {
          day,
          settled: Number(row?.settled ?? 0),
          scheduled: Number(row?.scheduled ?? 0),
          visitor: Number(row?.visitor ?? 0),
          averageTimeToSettleMs: row?.averageTimeToSettleMs ?? null,
        };
      });
    }),
  );
  const readMonitoring = async () => {
    const [unsettled, unnotified, scheduled] = await Promise.all([
      db.$queryRaw<
        { at: Date | null }[]
      >`SELECT MIN(COALESCE(p.sent_at, p.received_at)) AS at FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.send_state <> 'failed' AND p.stage IN ('sent', 'received', 'confirming')`,
      db.payment.aggregate({
        where: { stage: 'settled' },
        _min: { settledAt: true },
      }),
      db.order.findFirst({
        where: { source: 'schedule' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    return {
      oldestUnsettledAt: unsettled[0]?.at ?? null,
      oldestUnnotifiedAt: unnotified._min.settledAt,
      lastScheduledPurchaseAt: scheduled?.createdAt ?? null,
    };
  };
  const readRedis = () =>
    Promise.all([
      Promise.all(
        Object.entries(state.queues).map(async ([name, queue]) => {
          const counts = await queue.getJobCounts(
            'waiting',
            'prioritized',
            'active',
            'delayed',
          );
          return [
            name,
            Object.values(counts).reduce((sum, n) => sum + n, 0),
          ] as const;
        }),
      ),
      Promise.all(
        ['buyer', 'tracker', 'api'].map(
          async (name) =>
            [
              name,
              Math.max(0, await state.redis.pttl(cooldownKey(name))),
            ] as const,
        ),
      ),
      state.redis.get('visitor-paused-since'),
    ]);
  // Only a database failure fails /health. Redis parts are null while Redis is down, and chain
  // parts come from the shared snapshot, so a slow or failing RPC provider never delays it.
  app.get('/health', async (_request, reply) => {
    const [database, live] = await Promise.allSettled([
      Promise.all([
        db.cursor.findUnique({
          where: {
            name: `chain-${config.CHAIN_ID}-${config.SHOP_ADDRESS.toLowerCase()}`,
          },
        }),
        db.scanGap.count({ where: { resolvedAt: null } }),
        readMonitoring(),
      ]),
      readRedis(),
    ]);
    if (database.status === 'rejected')
      return reply
        .code(503)
        .send({ error: 'Live health state is unavailable' });
    const [cursor, openGaps, monitoring] = database.value;
    const [depths, cooldowns, pausedSince] =
      live.status === 'fulfilled' ? live.value : [null, null, null];
    const { reading, error } = state.snapshot.current();
    const chain = error ? null : reading;
    const chainError: ChainErrorCategory | null =
      error ?? (reading ? null : 'not_loaded');
    const balances = (balance: Balance) => ({
      ...balance,
      lowNative: balance.native < config.LOW_NATIVE_BALANCE,
      lowUsdc: balance.usdc < config.LOW_USDC_BALANCE,
    });
    return json({
      confirmations: config.CONFIRMATIONS,
      head: chain?.head ?? null,
      cursor: cursor?.blockNumber ?? null,
      lag:
        chain && cursor
          ? chain.head > cursor.blockNumber
            ? chain.head - cursor.blockNumber
            : 0n
          : null,
      openGaps,
      queueDepth: depths && Object.fromEntries(depths),
      cooldowns: cooldowns && Object.fromEntries(cooldowns),
      balances: chain
        ? {
            buyer: balances(chain.balances.buyer),
            shop: balances(chain.balances.shop),
          }
        : null,
      chainError,
      redisError: live.status === 'rejected' ? 'unavailable' : null,
      monitoring: {
        ...monitoring,
        cursorAdvancedAt: cursor?.advancedAt ?? null,
        visitorPausedSince: pausedSince
          ? new Date(Number(pausedSince)).toISOString()
          : null,
      },
    });
  });
}
