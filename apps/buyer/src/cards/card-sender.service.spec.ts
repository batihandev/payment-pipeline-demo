import { Redis } from 'ioredis';
import { ScriptedChain } from '../../../../libs/chain/testing/scripted-chain';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import { fakeConfig } from '../../../../libs/config/testing/config';
import { testDatabase } from '../../../../libs/db/testing/database';
import { CustomersService } from '../../../../libs/orders/src';
import {
  CardDeclinedError,
  type CardPayment,
  type CardPaymentInput,
  type StripeClient,
} from '../../../../libs/stripe/src';
import { OrderSenderService } from '../sending/order-sender.service';
import { RedisLock } from '../sending/redis-lock';
import type { BuyerConfig } from '../buyer-config';
import { CardSenderService } from './card-sender.service';

const buyer = `0x${'11'.repeat(20)}` as const;
const shop = `0x${'22'.repeat(20)}` as const;
const day = new Date('2026-10-20');

class FakeStripe implements StripeClient {
  readonly intents = new Map<string, CardPayment>();
  readonly requests: CardPaymentInput[] = [];
  failure: Error | null = null;
  failAfterAccepting = false;

  async createPayment(input: CardPaymentInput): Promise<CardPayment> {
    this.requests.push(input);
    if (this.failure && !this.failAfterAccepting) throw this.failure;
    const key = `order-${input.orderId}`;
    const intent = this.intents.get(key) ?? {
      id: `pi_${this.intents.size + 1}`,
      status: 'processing',
      receiptUrl: 'https://pay.stripe.com/receipts/test',
    };
    this.intents.set(key, intent);
    if (this.failure) throw this.failure;
    return intent;
  }
}

let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let stripe: FakeStripe;
let cards: CardSenderService;

beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 1 });
});
afterAll(async () => {
  await redis.quit();
  await database.close();
});
beforeEach(async () => {
  const db = database.db;
  await db.incident.deleteMany();
  await db.payment.deleteMany();
  await db.order.deleteMany();
  await db.customer.deleteMany();
  await db.dailyBudget.deleteMany();
  await db.walletNonce.deleteMany();
  await db.customer.create({
    data: {
      name: 'Demo customer',
      stripeCustomerId: 'cus_demo',
      stripePaymentMethodId: 'pm_demo',
    },
  });
  await db.dailyBudget.create({
    data: {
      day,
      targetCount: 10,
      targetAmount: 1000000n,
      reservedCount: 1,
      reservedAmount: 500000n,
    },
  });
  stripe = new FakeStripe();
  cards = new CardSenderService(db, stripe, new CustomersService(db));
});

async function order(
  data: {
    source?: 'visitor' | 'schedule';
    rail?: 'card' | 'chain';
    status?: 'open' | 'expired';
  } = {},
) {
  return database.db.order.create({
    data: {
      item: 'Lucky paperclip',
      price: 500000n,
      expectedAmount: (data.rail ?? 'card') === 'card' ? 500000n : 500001n,
      source: data.source ?? 'visitor',
      rail: data.rail ?? 'card',
      status: data.status ?? 'open',
      createdAt: day,
      expiresAt: new Date(day.getTime() + 1800000),
    },
  });
}
const payments = (orderId: string) =>
  database.db.payment.findMany({ where: { orderId } });
const stored = (id: string) =>
  database.db.order.findUniqueOrThrow({ where: { id } });
const budget = () =>
  database.db.dailyBudget.findUniqueOrThrow({ where: { day } });

it('charges a card order and records it as processing', async () => {
  const row = await order();
  await cards.charge(row.id, false);
  expect(stripe.requests).toEqual([
    {
      amountCents: 50,
      customer: 'cus_demo',
      paymentMethod: 'pm_demo',
      orderId: row.id,
    },
  ]);
  const [payment] = await payments(row.id);
  if (!payment) throw new Error('Payment was not recorded');
  expect(payment).toMatchObject({
    provider: 'stripe',
    externalKey: 'pi_1',
    amount: 500000n,
    stage: 'processing',
    receiptUrl: 'https://pay.stripe.com/receipts/test',
    final: false,
  });
  expect(payment.sentAt).toBeInstanceOf(Date);
  expect(await stored(row.id)).toMatchObject({
    sendState: 'sent',
    status: 'open',
    sendAttempts: 1,
  });
  expect(await database.db.ledgerEntry.count()).toBe(0);
});

it('never charges twice when retried after a timeout', async () => {
  const row = await order();
  stripe.failure = new RpcError('transient');
  stripe.failAfterAccepting = true;
  await expect(cards.charge(row.id, false)).rejects.toMatchObject({
    kind: 'transient',
  });
  expect(await payments(row.id)).toHaveLength(0);
  expect((await stored(row.id)).sendState).toBe('pending');
  stripe.failure = null;
  await cards.charge(row.id, false);
  await cards.charge(row.id, false);
  expect(stripe.intents.size).toBe(1);
  expect(stripe.requests).toHaveLength(2);
  expect(await payments(row.id)).toHaveLength(1);
  expect((await stored(row.id)).sendState).toBe('sent');
});

it('closes a declined card order with card_failed', async () => {
  const row = await order({ source: 'schedule' });
  stripe.failure = new CardDeclinedError('card_declined');
  await cards.charge(row.id, false);
  expect(await stored(row.id)).toMatchObject({
    sendState: 'failed',
    status: 'expired',
  });
  expect(await payments(row.id)).toHaveLength(0);
  expect(await budget()).toMatchObject({
    reservedCount: 0,
    reservedAmount: 0n,
  });
  expect(await database.db.incident.findMany()).toMatchObject([
    {
      kind: 'card_failed',
      whatHappened: 'The test card was declined.',
      howHandled: 'Closed the order; nothing was credited.',
    },
  ]);
});

it('leaves the budget alone when a visitor card order is declined', async () => {
  const row = await order();
  stripe.failure = new CardDeclinedError(null);
  await cards.charge(row.id, false);
  expect((await stored(row.id)).sendState).toBe('failed');
  expect(await budget()).toMatchObject({ reservedCount: 1 });
});

it('keeps a settled stage the webhook already wrote', async () => {
  const row = await order();
  await database.db.payment.create({
    data: {
      provider: 'stripe',
      externalKey: 'pi_1',
      orderId: row.id,
      amount: 500000n,
      stage: 'settled',
      final: true,
      settledAt: new Date(),
      finalAt: new Date(),
    },
  });
  await cards.charge(row.id, false);
  const rows = await payments(row.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    stage: 'settled',
    final: true,
    receiptUrl: 'https://pay.stripe.com/receipts/test',
    sentAt: expect.any(Date),
  });
  expect((await stored(row.id)).sendState).toBe('sent');
});

it('skips orders that are not pending', async () => {
  const row = await order();
  await database.db.order.update({
    where: { id: row.id },
    data: { sendState: 'sent' },
  });
  await cards.charge(row.id, false);
  expect(stripe.requests).toHaveLength(0);
});

it('closes an expired unsent order without charging', async () => {
  const row = await order({ source: 'schedule', status: 'expired' });
  await cards.charge(row.id, false);
  expect(stripe.requests).toHaveLength(0);
  expect((await stored(row.id)).sendState).toBe('failed');
  expect(await budget()).toMatchObject({ reservedCount: 0 });
});

it('retries a transient failure and sends the order to review when retries run out', async () => {
  const row = await order();
  stripe.failure = new RpcError('transient');
  await expect(cards.charge(row.id, false)).rejects.toMatchObject({
    kind: 'transient',
  });
  expect((await stored(row.id)).sendState).toBe('pending');
  await expect(cards.charge(row.id, true)).rejects.toMatchObject({
    kind: 'transient',
  });
  expect(await stored(row.id)).toMatchObject({
    sendState: 'review',
    status: 'open',
  });
  expect(await budget()).toMatchObject({ reservedCount: 1 });
  expect(
    await database.db.incident.count({ where: { kind: 'send_failed' } }),
  ).toBe(2);
});

it('closes the order when Stripe cannot be used at all', async () => {
  const row = await order({ source: 'schedule' });
  stripe.failure = new RpcError('permanent');
  await expect(cards.charge(row.id, false)).rejects.toMatchObject({
    kind: 'permanent',
  });
  expect(await stored(row.id)).toMatchObject({
    sendState: 'failed',
    status: 'expired',
  });
  expect(await budget()).toMatchObject({ reservedCount: 0 });
  expect(await database.db.incident.findFirstOrThrow()).toMatchObject({
    kind: 'send_failed',
  });
});

it('closes the order when the customer has no saved card', async () => {
  await database.db.customer.deleteMany();
  const row = await order();
  await expect(cards.charge(row.id, false)).rejects.toMatchObject({
    kind: 'permanent',
  });
  expect(stripe.requests).toHaveLength(0);
  expect((await stored(row.id)).sendState).toBe('failed');
});

it('leaves chain sends running while Stripe is rate-limited', async () => {
  const cardOrder = await order();
  const chainOrder = await order({ rail: 'chain' });
  stripe.failure = new RpcError('transient');
  await expect(cards.charge(cardOrder.id, false)).rejects.toMatchObject({
    kind: 'transient',
  });
  const chain = new ScriptedChain();
  const sender = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, `test-${Date.now()}-${Math.random()}`),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
  );
  await sender.sendForOrder(chainOrder.id);
  expect((await stored(chainOrder.id)).sendState).toBe('sent');
  expect(await sender.inFlight()).toBe(1);
  expect((await stored(cardOrder.id)).sendState).toBe('pending');
});

it('counts only chain transfers as in flight', async () => {
  const cardOrder = await order();
  await database.db.order.update({
    where: { id: cardOrder.id },
    data: {
      sendState: 'sent',
      payments: {
        create: {
          provider: 'stripe',
          externalKey: 'pi_sent',
          amount: 500000n,
          stage: 'sent',
        },
      },
    },
  });
  const chain = new ScriptedChain();
  const sender = new OrderSenderService(
    database.db,
    chain,
    chain,
    new RedisLock(redis, `test-${Date.now()}-${Math.random()}`),
    buyer,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: 84532 }),
  );
  expect(await sender.inFlight()).toBe(0);
});
