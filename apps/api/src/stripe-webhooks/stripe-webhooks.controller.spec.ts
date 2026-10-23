import { randomUUID } from 'node:crypto';
import request from 'supertest';
import Stripe from 'stripe';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { testDatabase } from '../../../../libs/db/testing/database';
import { PrismaService } from '../../../../libs/db/src';
import { utcDay } from '../../../../libs/core/src/time';
import { CustomersService } from '../../../../libs/orders/src';
import {
  CardDeclinedError,
  type StripeClient,
} from '../../../../libs/stripe/src';
import { CardSenderService } from '../../../buyer/src/cards/card-sender.service';
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
  await database.db.$executeRawUnsafe(
    'TRUNCATE stripe_events, incidents, customers, daily_budgets CASCADE',
  );
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

const order = (
  source: 'visitor' | 'schedule' = 'visitor',
  rail: 'card' | 'chain' = 'card',
) =>
  database.db.order.create({
    data: {
      item: 'Lucky paperclip',
      price: 50n * CENTS,
      expectedAmount: rail === 'card' ? 50n * CENTS : 50n * CENTS + 17n,
      source,
      rail,
      sendState: 'sent',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });

const STATUS_OF: Record<string, string> = {
  'payment_intent.processing': 'processing',
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.payment_failed': 'requires_payment_method',
};

function intentEvent(
  type: string,
  orderId: string,
  options: {
    id?: string;
    intent?: string;
    padding?: number;
    amount?: number;
    currency?: string;
  } = {},
) {
  return {
    id: options.id ?? `evt_${randomUUID()}`,
    object: 'event',
    type,
    data: {
      object: {
        id: options.intent ?? 'pi_1',
        object: 'payment_intent',
        status: STATUS_OF[type] ?? 'processing',
        amount: options.amount ?? 50,
        currency: options.currency ?? 'usd',
        metadata: {
          orderId,
          ...(options.padding ? { note: 'x'.repeat(options.padding) } : {}),
        },
        latest_charge: 'ch_1',
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

/** The buyer's card sender, charging the demo customer through `stripe`. */
async function cardSender(stripe: Pick<StripeClient, 'createPayment'>) {
  await db().customer.create({
    data: {
      name: 'Demo customer',
      stripeCustomerId: 'cus_demo',
      stripePaymentMethodId: 'pm_demo',
    },
  });
  return new CardSenderService(
    db(),
    stripe as StripeClient,
    new CustomersService(db()),
  );
}
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
  await db().order.update({ where: { id }, data: { sendState: 'pending' } });
  await post(intentEvent('payment_intent.succeeded', id));
  const [created] = await payments();
  await (
    await cardSender({
      createPayment: () =>
        Promise.resolve({
          id: 'pi_1',
          receiptUrl: 'https://pay.stripe.com/receipts/test',
        }),
    })
  ).charge(id, false);
  const all = await payments();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({
    id: created?.id,
    stage: 'settled',
    sentAt: created?.sentAt,
    receiptUrl: 'https://pay.stripe.com/receipts/test',
  });
  expect(await db().ledgerEntry.count()).toBe(1);
});

it('keeps the stored receipt URL when the event has a charge id', async () => {
  const { id } = await order();
  await db().payment.create({
    data: {
      provider: 'stripe',
      externalKey: 'pi_1',
      orderId: id,
      amount: 50n * CENTS,
      stage: 'processing',
      receiptUrl: 'https://pay.stripe.com/receipts/stored',
    },
  });
  await post(intentEvent('payment_intent.succeeded', id));
  expect((await payments())[0]).toMatchObject({
    stage: 'settled',
    receiptUrl: 'https://pay.stripe.com/receipts/stored',
  });
});

it('settles without a receipt URL when none is known', async () => {
  const { id } = await order();
  await post(intentEvent('payment_intent.succeeded', id));
  expect((await payments())[0]).toMatchObject({
    stage: 'settled',
    receiptUrl: null,
  });
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

it('marks the payment failed and final on payment_failed', async () => {
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
  await post(intentEvent('payment_intent.payment_failed', id));
  const [payment] = await payments();
  expect(payment).toMatchObject({ stage: 'failed', final: true });
  expect(payment?.finalAt).toBeInstanceOf(Date);
  const stages = (await db().paymentEvent.findMany()).map(
    (row) => (JSON.parse(row.body) as { stage: string }).stage,
  );
  expect(stages).toEqual(['failed']);
  await post(intentEvent('payment_intent.processing', id));
  await post(intentEvent('payment_intent.succeeded', id));
  expect((await payments())[0]).toMatchObject({ stage: 'failed' });
  expect(await db().ledgerEntry.count()).toBe(0);
});

it('records card_failed once for a declined card', async () => {
  const { id } = await order();
  await db().order.update({ where: { id }, data: { sendState: 'pending' } });
  await (
    await cardSender({
      createPayment: () => {
        return Promise.reject(new CardDeclinedError('card_declined', 'pi_1'));
      },
    })
  ).charge(id, false);
  await post(intentEvent('payment_intent.payment_failed', id));
  const all = await payments();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ stage: 'failed', final: true });
  const incidents = await db().incident.findMany({
    where: { kind: 'card_failed' },
  });
  expect(incidents).toHaveLength(1);
  expect(incidents[0]?.paymentId).toBe(all[0]?.id);
});

it('releases the budget when an expired processing order fails', async () => {
  const { id, createdAt } = await order('schedule');
  await db().order.update({ where: { id }, data: { status: 'expired' } });
  await db().dailyBudget.create({
    data: {
      day: utcDay(createdAt),
      targetCount: 10,
      targetAmount: 10_000_000n,
      reservedCount: 1,
      reservedAmount: 50n * CENTS,
    },
  });
  await db().payment.create({
    data: {
      provider: 'stripe',
      externalKey: 'pi_1',
      orderId: id,
      amount: 50n * CENTS,
      stage: 'processing',
    },
  });
  await post(intentEvent('payment_intent.payment_failed', id));
  expect(
    (await db().order.findUniqueOrThrow({ where: { id } })).sendState,
  ).toBe('failed');
  expect(await db().dailyBudget.findFirstOrThrow()).toMatchObject({
    reservedCount: 0,
    reservedAmount: 0n,
  });
});

it('notes a card payment that settled after expiry', async () => {
  const { id } = await order();
  await db().order.update({ where: { id }, data: { status: 'expired' } });
  await post(intentEvent('payment_intent.succeeded', id));
  const [payment] = await payments();
  expect(payment).toMatchObject({ stage: 'settled' });
  const notes = await db().incident.findMany({
    where: { kind: 'paid_after_expiry' },
  });
  expect(notes).toHaveLength(1);
  expect(notes[0]?.paymentId).toBe(payment?.id);
});

const unmatched = () => db().incident.count({ where: { kind: 'unmatched' } });

it('never applies a card event to a chain order', async () => {
  const { id } = await order('visitor', 'chain');
  const response = await post(intentEvent('payment_intent.succeeded', id));
  expect(response.statusCode).toBe(200);
  expect(await payments()).toHaveLength(0);
  expect(await db().ledgerEntry.count()).toBe(0);
  expect((await db().order.findUniqueOrThrow({ where: { id } })).status).toBe(
    'open',
  );
  expect(await unmatched()).toBe(1);
});

it('rejects an event whose amount differs from the order', async () => {
  const { id } = await order();
  await post(intentEvent('payment_intent.succeeded', id, { amount: 51 }));
  await post(
    intentEvent('payment_intent.succeeded', id, {
      intent: 'pi_eur',
      currency: 'eur',
    }),
  );
  expect(await payments()).toHaveLength(0);
  expect(await db().ledgerEntry.count()).toBe(0);
  expect(await unmatched()).toBe(2);
});

it('never settles a second PaymentIntent for one order', async () => {
  const { id } = await order();
  await post(intentEvent('payment_intent.succeeded', id));
  await post(intentEvent('payment_intent.succeeded', id, { intent: 'pi_2' }));
  const all = await payments();
  expect(all).toHaveLength(1);
  expect(all[0]?.externalKey).toBe('pi_1');
  expect(await db().ledgerEntry.count()).toBe(1);
  expect(await unmatched()).toBe(1);
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
