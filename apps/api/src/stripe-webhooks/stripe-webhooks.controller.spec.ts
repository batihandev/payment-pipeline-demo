import { randomUUID } from 'node:crypto';
import request from 'supertest';
import Stripe from 'stripe';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { testDatabase } from '../../../../libs/db/testing/database';
import { PrismaService } from '../../../../libs/db/src';
import { createTestApp } from '../../testing/app';

const secret = 'whsec_test_secret';
const CENTS = 10000n;

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: NestExpressApplication;

beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.db.$executeRawUnsafe('TRUNCATE payments, orders CASCADE');
  await database.db.$executeRawUnsafe('TRUNCATE stripe_events, incidents');
  app = await createTestApp({
    environment: { STRIPE_WEBHOOK_SECRET: secret },
    override: (builder) => {
      builder.overrideProvider(PrismaService).useValue(database.db);
    },
  });
});
afterEach(async () => {
  await app.close();
});

const order = (source: 'visitor' | 'schedule' = 'visitor') =>
  database.db.order.create({
    data: {
      item: 'Lucky paperclip',
      price: 50n * CENTS,
      expectedAmount: 50n * CENTS,
      source,
      rail: 'card',
      sendState: 'sent',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });

function intentEvent(
  type: string,
  orderId: string,
  options: { id?: string; intent?: string; padding?: number } = {},
) {
  return {
    id: options.id ?? `evt_${randomUUID()}`,
    object: 'event',
    type,
    data: {
      object: {
        id: options.intent ?? 'pi_1',
        object: 'payment_intent',
        amount: 50,
        currency: 'usd',
        metadata: {
          orderId,
          ...(options.padding ? { note: 'x'.repeat(options.padding) } : {}),
        },
        latest_charge: {
          id: 'ch_1',
          receipt_url: 'https://pay.stripe.com/receipts/test',
        },
      },
    },
  };
}

function post(event: object, signingSecret = secret) {
  const payload = JSON.stringify(event);
  return request(app.getHttpServer())
    .post('/stripe/webhooks')
    .set('content-type', 'application/json')
    .set(
      'stripe-signature',
      Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: signingSecret,
      }),
    )
    .send(payload);
}

const db = () => database.db;
const payments = () => db().payment.findMany();

it('settles a card payment once', async () => {
  const { id } = await order();
  const response = await post(intentEvent('payment_intent.succeeded', id));
  expect(response.statusCode).toBe(200);
  const [payment] = await payments();
  expect(payment).toMatchObject({
    provider: 'stripe',
    externalKey: 'pi_1',
    orderId: id,
    amount: 50n * CENTS,
    stage: 'settled',
    final: true,
    receiptUrl: 'https://pay.stripe.com/receipts/test',
  });
  expect(payment?.settledAt).toBeInstanceOf(Date);
  expect(payment?.finalAt).toBeInstanceOf(Date);
  expect(await db().ledgerEntry.count()).toBe(1);
  expect(await db().notice.count()).toBe(1);
  expect((await db().order.findUniqueOrThrow({ where: { id } })).status).toBe(
    'paid',
  );
  const stages = (await db().paymentEvent.findMany()).map(
    (row) => (JSON.parse(row.body) as { stage: string }).stage,
  );
  expect(stages).toEqual(['settled']);
});

it('creates the payment when the webhook arrives first', async () => {
  const { id } = await order();
  await post(intentEvent('payment_intent.succeeded', id));
  const [created] = await payments();
  await db().$transaction(async (tx) => {
    await tx.payment.upsert({
      where: {
        provider_externalKey: { provider: 'stripe', externalKey: 'pi_1' },
      },
      create: {
        provider: 'stripe',
        externalKey: 'pi_1',
        orderId: id,
        amount: 50n * CENTS,
        stage: 'processing',
      },
      update: { orderId: id },
    });
    await tx.payment.updateMany({
      where: {
        externalKey: 'pi_1',
        stage: { in: ['sent', 'received', 'confirming'] },
      },
      data: { stage: 'processing' },
    });
  });
  const all = await payments();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ id: created?.id, stage: 'settled' });
});

it('moves a payment the buyer wrote forward to settled', async () => {
  const { id } = await order();
  await db().payment.create({
    data: {
      provider: 'stripe',
      externalKey: 'pi_1',
      orderId: id,
      amount: 50n * CENTS,
      stage: 'processing',
      processingAt: new Date(),
    },
  });
  await post(intentEvent('payment_intent.succeeded', id));
  expect(await payments()).toHaveLength(1);
  expect((await payments())[0]).toMatchObject({
    stage: 'settled',
    final: true,
  });
});

it('moves a new payment to processing', async () => {
  const { id } = await order();
  await post(intentEvent('payment_intent.processing', id));
  expect((await payments())[0]).toMatchObject({
    stage: 'processing',
    final: false,
  });
  expect(await db().ledgerEntry.count()).toBe(0);
  expect(await db().paymentEvent.count()).toBe(1);
});

it('ignores a repeated event and counts it as a duplicate', async () => {
  const { id } = await order();
  const event = intentEvent('payment_intent.succeeded', id, { id: 'evt_same' });
  expect((await post(event)).statusCode).toBe(200);
  expect((await post(event)).statusCode).toBe(200);
  expect(await db().ledgerEntry.count()).toBe(1);
  expect(await db().paymentEvent.count()).toBe(1);
  expect(await db().stripeEvent.count()).toBe(1);
  const incidents = await db().incident.findMany({
    where: { kind: 'duplicate' },
  });
  expect(incidents).toHaveLength(1);
  expect(incidents[0]?.paymentId).toBe((await payments())[0]?.id);
});

it('never moves a settled payment back to processing', async () => {
  const { id } = await order();
  await post(intentEvent('payment_intent.succeeded', id));
  const response = await post(intentEvent('payment_intent.processing', id));
  expect(response.statusCode).toBe(200);
  expect((await payments())[0]).toMatchObject({ stage: 'settled' });
  expect(await db().ledgerEntry.count()).toBe(1);
  expect(await db().paymentEvent.count()).toBe(1);
});

it('settles once when different events report the same success', async () => {
  const { id } = await order();
  await post(intentEvent('payment_intent.succeeded', id));
  await post(intentEvent('payment_intent.succeeded', id));
  expect(await db().ledgerEntry.count()).toBe(1);
  expect(await db().paymentEvent.count()).toBe(1);
});

it('rejects a bad signature', async () => {
  const { id } = await order();
  const response = await post(
    intentEvent('payment_intent.succeeded', id),
    'whsec_other',
  );
  expect(response.statusCode).toBe(400);
  expect(response.body).toEqual({ error: 'invalid_signature' });
  expect(await db().stripeEvent.count()).toBe(0);
  expect(await payments()).toHaveLength(0);
});

it('rejects a request without a signature header', async () => {
  const response = await request(app.getHttpServer())
    .post('/stripe/webhooks')
    .set('content-type', 'application/json')
    .send('{}');
  expect(response.statusCode).toBe(400);
  expect(response.body).toEqual({ error: 'invalid_signature' });
});

it('accepts an event larger than 4 KB', async () => {
  const { id } = await order();
  const response = await post(
    intentEvent('payment_intent.succeeded', id, { padding: 8000 }),
  );
  expect(response.statusCode).toBe(200);
  expect((await payments())[0]).toMatchObject({ stage: 'settled' });
});

it('closes the order on payment_failed', async () => {
  const { id } = await order();
  const response = await post(intentEvent('payment_intent.payment_failed', id));
  expect(response.statusCode).toBe(200);
  expect(await db().order.findUniqueOrThrow({ where: { id } })).toMatchObject({
    status: 'expired',
    sendState: 'failed',
  });
  const incident = await db().incident.findFirstOrThrow({
    where: { kind: 'card_failed' },
  });
  expect(incident.paymentId).toBe((await payments())[0]?.id);
  expect(await db().ledgerEntry.count()).toBe(0);
});

it('leaves a settled payment alone when a failure arrives late', async () => {
  const { id } = await order();
  await post(intentEvent('payment_intent.succeeded', id));
  await post(intentEvent('payment_intent.payment_failed', id));
  expect((await db().order.findUniqueOrThrow({ where: { id } })).status).toBe(
    'paid',
  );
  expect(await db().incident.count({ where: { kind: 'card_failed' } })).toBe(0);
});

it('stores other event types without acting', async () => {
  const response = await post({
    id: 'evt_other',
    object: 'event',
    type: 'customer.created',
    data: { object: { id: 'cus_1', object: 'customer' } },
  });
  expect(response.statusCode).toBe(200);
  expect(await db().stripeEvent.count()).toBe(1);
  expect(await payments()).toHaveLength(0);
});

it('records an unmatched incident for an unknown order id', async () => {
  const response = await post(
    intentEvent('payment_intent.succeeded', randomUUID()),
  );
  expect(response.statusCode).toBe(200);
  expect(await db().stripeEvent.count()).toBe(1);
  expect(await payments()).toHaveLength(0);
  expect(await db().incident.count({ where: { kind: 'unmatched' } })).toBe(1);
});

it('records an unmatched incident when the order id is not an id', async () => {
  const response = await post(
    intentEvent('payment_intent.succeeded', 'not-a-uuid'),
  );
  expect(response.statusCode).toBe(200);
  expect(await db().incident.count({ where: { kind: 'unmatched' } })).toBe(1);
});

describe('without a webhook secret', () => {
  it('rejects every event', async () => {
    await app.close();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    app = await createTestApp({
      override: (builder) => {
        builder.overrideProvider(PrismaService).useValue(database.db);
      },
    });
    const { id } = await order();
    const response = await post(intentEvent('payment_intent.succeeded', id));
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_signature' });
    expect(await payments()).toHaveLength(0);
  });
});
