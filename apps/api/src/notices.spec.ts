import { FastifyAdapter } from '@nestjs/platform-fastify';
import { testDatabase } from '../../../libs/db/testing/database';
import { signNotice } from '../../../libs/core/src/notices';
import { registerNotices } from './notices';
let database: Awaited<ReturnType<typeof testDatabase>>;
let adapter: FastifyAdapter;
const secret = 'notice-test-secret'.repeat(3);
const now = new Date('2026-10-20T12:00:00Z');
const timestamp = Math.floor(now.getTime() / 1000);
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.db.$executeRawUnsafe('TRUNCATE payments CASCADE');
  adapter = new FastifyAdapter();
  adapter.useBodyParser('application/json', true);
  registerNotices(adapter.getInstance(), database.db, secret, () => now);
});
afterEach(async () => {
  await adapter.close();
});
const payment = (stage: 'settled' | 'received' = 'settled') =>
  database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: 'notice',
      amount: 100n,
      stage,
      settledAt: stage === 'settled' ? now : null,
    },
  });
const send = (
  body: string,
  signature = signNotice(body, secret, timestamp),
  time = String(timestamp),
) =>
  adapter.getInstance().inject({
    method: 'POST',
    url: '/shop/notices',
    headers: {
      'content-type': 'application/json',
      'x-notice-timestamp': time,
      'x-notice-signature': signature,
    },
    payload: body,
  });
it('accepts the tracker signature format and saves the notified transition and event together', async () => {
  const row = await payment();
  const response = await send(JSON.stringify({ paymentId: row.id }));
  expect(response.statusCode).toBe(200);
  expect(
    await database.db.payment.findUniqueOrThrow({ where: { id: row.id } }),
  ).toMatchObject({ stage: 'notified', notifiedAt: now });
  const event = await database.db.paymentEvent.findFirstOrThrow();
  expect(JSON.parse(event.body)).toMatchObject({
    id: row.id,
    stage: 'notified',
    amount: '100',
  });
  expect((await database.db.notice.findFirstOrThrow()).deliveredAt).toEqual(
    now,
  );
});
it('returns 401 for bad, expired, future and malformed signatures or timestamps', async () => {
  const row = await payment();
  const body = JSON.stringify({ paymentId: row.id });
  for (const [signature, time] of [
    ['0'.repeat(64), String(timestamp)],
    [signNotice(body, secret, timestamp - 301), String(timestamp - 301)],
    [signNotice(body, secret, timestamp + 1), String(timestamp + 1)],
    ['bad', 'NaN'],
    [signNotice(body, secret, timestamp), `${timestamp}.0`],
  ])
    expect((await send(body, signature, time)).statusCode).toBe(401);
  expect((await database.db.payment.findFirstOrThrow()).stage).toBe('settled');
  expect(await database.db.paymentEvent.count()).toBe(0);
});
it('verifies exact JSON bytes including whitespace', async () => {
  const row = await payment();
  const body = JSON.stringify({ paymentId: row.id });
  const spaced = `{ "paymentId": "${row.id}" }`;
  expect(
    (await send(spaced, signNotice(body, secret, timestamp))).statusCode,
  ).toBe(401);
  expect((await send(spaced)).statusCode).toBe(200);
});
it('accepts repeated concurrent notices without a second transition or event', async () => {
  const row = await payment();
  const body = JSON.stringify({ paymentId: row.id });
  const responses = await Promise.all([send(body), send(body), send(body)]);
  expect(responses.map((response) => response.statusCode)).toEqual([
    200, 200, 200,
  ]);
  expect(await database.db.paymentEvent.count()).toBe(1);
  expect(await database.db.notice.count()).toBe(1);
  expect((await database.db.payment.findFirstOrThrow()).notifiedAt).toEqual(
    now,
  );
});
it('refuses an unknown or unsettled payment without advancing it', async () => {
  expect(
    (
      await send(
        JSON.stringify({ paymentId: '00000000-0000-4000-8000-000000000001' }),
      )
    ).statusCode,
  ).toBe(404);
  const row = await payment('received');
  expect((await send(JSON.stringify({ paymentId: row.id }))).statusCode).toBe(
    409,
  );
  expect((await database.db.payment.findFirstOrThrow()).stage).toBe('received');
});
it('rolls back the notified transition when its durable event cannot be written', async () => {
  const row = await payment();
  await database.db.$executeRawUnsafe(
    'ALTER TABLE payment_events ADD CONSTRAINT reject_event CHECK (false)',
  );
  try {
    expect((await send(JSON.stringify({ paymentId: row.id }))).statusCode).toBe(
      500,
    );
    expect((await database.db.payment.findFirstOrThrow()).stage).toBe(
      'settled',
    );
    expect(await database.db.notice.count()).toBe(0);
  } finally {
    await database.db.$executeRawUnsafe(
      'ALTER TABLE payment_events DROP CONSTRAINT reject_event',
    );
  }
});
