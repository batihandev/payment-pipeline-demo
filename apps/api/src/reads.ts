import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import type { apiSchema } from '../../../libs/config/src';
import type { PrismaClient } from '../../../libs/db/src';
import type { ChainClient } from '../../../libs/chain/src/chain-client';
import { cooldownKey } from '../../../libs/chain/src/service-limiter';
export type ApiConfig = z.output<typeof apiSchema>;
export type ReadState = {
  chain: Pick<ChainClient, 'getHead' | 'getBalances'>;
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
      >`SELECT id FROM payments ORDER BY COALESCE(sent_at, received_at) DESC NULLS LAST, id DESC LIMIT ${request.query.limit}`;
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
            ...row,
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
  let cache: { expires: number; value: unknown } | undefined;
  let loading: Promise<unknown> | undefined;
  app.get('/stats', async () => {
    const now = state.now ?? Date.now;
    if (cache && now() < cache.expires) return cache.value;
    loading ??= (async () => {
      const [rows, duplicatesSkipped, failuresRecovered] = await Promise.all([
        db.$queryRaw<
          { settledCount: bigint; averageTimeToSettleMs: number | null }[]
        >`SELECT COUNT(*)::bigint AS "settledCount", AVG(EXTRACT(EPOCH FROM (p.settled_at - COALESCE(p.sent_at, p.received_at))) * 1000)::float8 AS "averageTimeToSettleMs" FROM ledger_entries l JOIN payments p ON p.id = l.payment_id`,
        db.incident.count({ where: { kind: 'duplicate' } }),
        db.incident.count({ where: { kind: 'gap_recovered' } }),
      ]);
      const value = {
        settledCount: Number(rows[0]?.settledCount ?? 0),
        averageTimeToSettleMs: rows[0]?.averageTimeToSettleMs ?? null,
        duplicatesSkipped,
        failuresRecovered,
      };
      cache = { expires: now() + 5000, value };
      return value;
    })();
    try {
      return await loading;
    } finally {
      loading = undefined;
    }
  });
  app.get('/health', async (_request, reply) => {
    try {
      const [head, cursor, openGaps, buyer, shop, depths, cooldowns] =
        await Promise.all([
          state.chain.getHead(),
          db.cursor.findUnique({
            where: {
              name: `chain-${config.CHAIN_ID}-${config.SHOP_ADDRESS.toLowerCase()}`,
            },
          }),
          db.scanGap.count({ where: { resolvedAt: null } }),
          state.chain.getBalances(config.BUYER_ADDRESS as `0x${string}`),
          state.chain.getBalances(config.SHOP_ADDRESS as `0x${string}`),
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
        ]);
      const balances = (balance: { native: bigint; usdc: bigint }) => ({
        ...balance,
        lowNative: balance.native < config.LOW_NATIVE_BALANCE,
        lowUsdc: balance.usdc < config.LOW_USDC_BALANCE,
      });
      return json({
        confirmations: config.CONFIRMATIONS,
        head: head.number,
        cursor: cursor?.blockNumber ?? null,
        lag: cursor
          ? head.number > cursor.blockNumber
            ? head.number - cursor.blockNumber
            : 0n
          : null,
        openGaps,
        queueDepth: Object.fromEntries(depths),
        cooldowns: Object.fromEntries(cooldowns),
        balances: { buyer: balances(buyer), shop: balances(shop) },
      });
    } catch {
      return reply
        .code(503)
        .send({ error: 'Live health state is unavailable' });
    }
  });
}
