import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { testDatabase } from '../../../../libs/db/testing/database';
import { signNotice } from '../../../../libs/core/src/notices';
import { PrismaService } from '../../../../libs/db/src';
import { createTestApp } from '../../testing/app';
import { NOW } from '../common/clock.module';

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: NestFastifyApplication;
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
  app = await createTestApp({
    environment: { NOTICE_SECRET: secret },
    override: (builder) => {
      builder
        .overrideProvider(PrismaService)
        .useValue(database.db)
        .overrideProvider(NOW)
        .useValue(() => now);
    },
  });
});
afterEach(async () => {
  await app.close();
});
const payment = (stage: 'settled' | 'received' = 'settled') =>
  database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: randomUUID(),
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
  request(app.getHttpServer())
    .post('/shop/notices')
    .set('content-type', 'application/json')
    .set('x-notice-timestamp', time)
    .set('x-notice-signature', signature)
    .send(body);
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
it('answers the delivered payment with ok and the refusals with their codes', async () => {
  const row = await payment();
  const body = JSON.stringify({ paymentId: row.id });
  const delivered = await send(body);
  expect([delivered.statusCode, delivered.body]).toEqual([200, { ok: true }]);
  const unknown = await send(
    JSON.stringify({ paymentId: '00000000-0000-4000-8000-000000000001' }),
  );
  expect([unknown.statusCode, unknown.body]).toEqual([
    404,
    { error: 'payment_not_found' },
  ]);
  const unsettled = await payment('received');
  const refused = await send(JSON.stringify({ paymentId: unsettled.id }));
  expect([refused.statusCode, refused.body]).toEqual([
    409,
    { error: 'payment_not_settled' },
  ]);
});
it('rejects unknown notice body fields', async () => {
  const row = await payment();
  const response = await send(
    JSON.stringify({ paymentId: row.id, extra: true }),
  );
  expect(response.statusCode).toBe(400);
  expect(response.body).toEqual({ error: 'invalid_notice_body' });
  expect((await database.db.payment.findFirstOrThrow()).stage).toBe('settled');
});
it('rejects a body without a payment id', async () => {
  for (const body of ['{}', JSON.stringify({ paymentId: 'not-a-uuid' })]) {
    const response = await send(body);
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_notice_body' });
  }
});
it('checks the signature before the body', async () => {
  const response = await send('{}', '0'.repeat(64));
  expect(response.statusCode).toBe(401);
  expect(response.body).toEqual({ error: 'invalid_notice_signature' });
});
it('refuses a body over 4 KB', async () => {
  const body = JSON.stringify({ paymentId: 'x'.repeat(5000) });
  const response = await send(body);
  expect(response.statusCode).toBe(413);
  expect(response.body).toEqual({ error: 'payload_too_large' });
});
