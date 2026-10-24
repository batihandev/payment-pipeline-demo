import { expect, it } from 'vitest';
import { z } from 'zod';
import request from 'supertest';
import {
  payment as createPayment,
  today,
  useReadApi,
} from '../../testing/read-api';

const state = useReadApi();
const get = (url: string) => request(state.app.getHttpServer()).get(url);
const dailyRows = z.array(
  z.object({
    day: z.string(),
    settled: z.number(),
    scheduled: z.number(),
    visitor: z.number(),
    averageTimeToSettleMs: z.number().nullable(),
  }),
);
const daily = async () => dailyRows.parse((await get('/stats/daily')).body);
const payment = (data = {}) => createPayment(state, data);
it('computes statistics from ledger rows and incidents and refreshes after five seconds', async () => {
  const first = await get('/stats');
  expect(first.headers).not.toHaveProperty('x-powered-by');
  expect(first.headers).not.toHaveProperty('etag');
  expect(first.body).toEqual({
    settledCount: 0,
    averageTimeToSettleMs: null,
    duplicatesSkipped: 0,
    failuresRecovered: 0,
  });
  const row = await payment({
    receivedAt: new Date('2026-10-22T08:00:00Z'),
    settledAt: new Date('2026-10-22T08:00:08Z'),
    stage: 'notified',
  });
  await state.database.db.ledgerEntry.create({
    data: { paymentId: row.id, amount: row.amount },
  });
  await state.database.db.incident.createMany({
    data: ['duplicate', 'gap_recovered', 'rpc_failed'].map((kind) => ({
      kind,
      whatHappened: kind,
      howHandled: 'Handled',
      createdAt: new Date('2026-10-22T09:00:00Z'),
    })),
  });
  state.time = today + 4999;
  expect((await get('/stats')).body).toMatchObject({ settledCount: 0 });
  state.time = today + 5000;
  expect((await get('/stats')).body).toEqual({
    settledCount: 1,
    averageTimeToSettleMs: 8000,
    duplicatesSkipped: 1,
    failuresRecovered: 1,
  });
});
const settle = async (
  settledAt: string,
  source?: 'schedule' | 'visitor',
  seconds = 10,
) => {
  const order = source
    ? await state.database.db.order.create({
        data: {
          item: 'Duck',
          price: 14000000n,
          expectedAmount: 14000731n,
          source,
          expiresAt: new Date(),
          signedTransaction: 'x',
        },
      })
    : undefined;
  const settled = new Date(settledAt);
  const row = await payment({
    orderId: order?.id,
    receivedAt: new Date(settled.getTime() - seconds * 1000),
    settledAt: settled,
    stage: 'notified',
  });
  await state.database.db.ledgerEntry.create({
    data: { paymentId: row.id, amount: row.amount },
  });
};
it('counts only today in /stats', async () => {
  await settle('2026-10-21T23:59:59Z', 'visitor');
  await settle('2026-10-22T00:00:00Z', 'visitor', 4);
  await settle('2026-10-22T11:00:00Z', 'schedule', 8);
  await state.database.db.incident.createMany({
    data: (
      [
        ['duplicate', '2026-10-21T23:59:59Z'],
        ['duplicate', '2026-10-22T01:00:00Z'],
        ['gap_recovered', '2026-10-21T10:00:00Z'],
      ] as const
    ).map(([kind, at]) => ({
      kind,
      whatHappened: kind,
      howHandled: 'Handled',
      createdAt: new Date(at),
    })),
  });
  expect((await get('/stats')).body).toEqual({
    settledCount: 2,
    averageTimeToSettleMs: 6000,
    duplicatesSkipped: 1,
    failuresRecovered: 0,
  });
});
it('returns 30 zero-filled days in /stats/daily with scheduled and visitor split', async () => {
  await settle('2026-10-22T11:00:00Z', 'schedule', 8);
  await settle('2026-10-22T11:30:00Z', 'visitor', 4);
  await settle('2026-10-20T11:30:00Z', 'visitor', 10);
  await settle('2026-09-23T00:00:00Z');
  await settle('2026-09-22T23:59:59Z', 'visitor');
  const days = await daily();
  expect(days).toHaveLength(30);
  expect(days[0]).toEqual({
    day: '2026-09-23',
    settled: 1,
    scheduled: 0,
    visitor: 0,
    averageTimeToSettleMs: 10000,
  });
  expect(days[29]).toEqual({
    day: '2026-10-22',
    settled: 2,
    scheduled: 1,
    visitor: 1,
    averageTimeToSettleMs: 6000,
  });
  expect(days[27]).toEqual({
    day: '2026-10-20',
    settled: 1,
    scheduled: 0,
    visitor: 1,
    averageTimeToSettleMs: 10000,
  });
  expect(days[28]).toEqual({
    day: '2026-10-21',
    settled: 0,
    scheduled: 0,
    visitor: 0,
    averageTimeToSettleMs: null,
  });
  await settle('2026-10-22T11:45:00Z', 'visitor');
  state.time = today + 59999;
  expect((await daily())[29]?.settled).toBe(2);
  state.time = today + 60000;
  expect((await daily())[29]?.settled).toBe(3);
});
