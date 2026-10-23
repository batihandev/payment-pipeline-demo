import { Redis } from 'ioredis';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { cooldownKey } from '../../../../libs/chain/src/service-limiter';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import type { SendState } from '../../../../libs/db/src';
import { testDatabase } from '../../../../libs/db/testing/database';
import {
  FakeStripe,
  paymentIntent,
} from '../../../../libs/stripe/testing/fake-stripe';
import { RpcLimiter } from '../../../../libs/chain/src/rpc-limiter';
import {
  SdkStripeClient,
  StripeAccessError,
} from '../../../../libs/stripe/src/stripe-client';
import { applyIntent } from '../../../../libs/stripe/src';
import { CardReconcilerService } from './card-reconciler.service';

const now = new Date('2026-10-23T12:00:00Z');
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000);

let database: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
let stripe: FakeStripe;
let reconciler: CardReconcilerService;

beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 1 });
});
afterAll(async () => {
  await redis.quit();
  await database.close();
});
beforeEach(async () => {
  await database.db.$executeRawUnsafe(
    'TRUNCATE payments, orders, incidents, daily_budgets CASCADE',
  );
  await redis.del(cooldownKey('stripe'));
  stripe = new FakeStripe();
  reconciler = new CardReconcilerService(database.db, stripe, redis);
});

const db = () => database.db;

function order(
  data: {
    sendState?: SendState;
    status?: 'open' | 'expired';
    source?: 'visitor' | 'schedule';
  } = {},
  createdAt = minutesAgo(10),
) {
  return db().order.create({
    data: {
      item: 'Lucky paperclip',
      price: 500000n,
      expectedAmount: 500000n,
      source: data.source ?? 'visitor',
      rail: 'card',
      sendState: data.sendState ?? 'sent',
      status: data.status ?? 'open',
      sendAttempts: 1,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 1_800_000),
    },
  });
}

function payment(
  orderId: string,
  stage: 'sent' | 'processing' | 'settled',
  at = minutesAgo(5),
  externalKey = 'pi_1',
) {
  return db().payment.create({
    data: {
      provider: 'stripe',
      externalKey,
      orderId,
      amount: 500000n,
      stage,
      sentAt: at,
      processingAt: stage === 'sent' ? null : at,
      final: stage === 'settled',
    },
  });
}

it('settles a processing card payment whose webhook never came', async () => {
  const { id } = await order();
  await payment(id, 'processing');
  stripe.stored.set(
    'pi_1',
    paymentIntent({
      id: 'pi_1',
      status: 'succeeded',
      orderId: id,
      receiptUrl: 'https://pay.stripe.com/receipts/1',
    }),
  );
  await reconciler.run(now);
  expect(stripe.lookups).toEqual(['pi_1']);
  expect(await db().payment.findFirstOrThrow()).toMatchObject({
    stage: 'settled',
    final: true,
    receiptUrl: 'https://pay.stripe.com/receipts/1',
  });
  expect(await db().ledgerEntry.count()).toBe(1);
  expect((await db().order.findUniqueOrThrow({ where: { id } })).status).toBe(
    'paid',
  );
});

it('leaves a recent payment to the webhook', async () => {
  const { id } = await order();
  await payment(id, 'processing', minutesAgo(1));
  await reconciler.run(now);
  expect(stripe.lookups).toEqual([]);
});

it('finds a charge that has no payment row', async () => {
  const review = await order({ sendState: 'review' });
  const expired = await order({ sendState: 'failed', status: 'expired' });
  await order({ sendState: 'review' }, minutesAgo(1));
  stripe.stored.set(
    'pi_review',
    paymentIntent({ id: 'pi_review', status: 'succeeded', orderId: review.id }),
  );
  await reconciler.run(now);
  expect(stripe.lookups.sort()).toEqual([expired.id, review.id].sort());
  const [found] = await db().payment.findMany();
  expect(found).toMatchObject({
    externalKey: 'pi_review',
    orderId: review.id,
    stage: 'settled',
  });
  expect(await db().ledgerEntry.count()).toBe(1);
});

it('leaves a payment the webhook already settled', async () => {
  const { id } = await order();
  await payment(id, 'settled');
  stripe.stored.set(
    'pi_1',
    paymentIntent({ id: 'pi_1', status: 'succeeded', orderId: id }),
  );
  await reconciler.run(now);
  expect(stripe.lookups).toEqual([]);
  expect(await db().ledgerEntry.count()).toBe(0);
  expect(await db().paymentEvent.count()).toBe(0);
});

it('fails a payment whose charge failed', async () => {
  const { id } = await order();
  await payment(id, 'sent');
  stripe.stored.set(
    'pi_1',
    paymentIntent({
      id: 'pi_1',
      status: 'requires_payment_method',
      orderId: id,
    }),
  );
  await reconciler.run(now);
  expect(await db().payment.findFirstOrThrow()).toMatchObject({
    stage: 'failed',
    final: true,
  });
  expect(await db().incident.count({ where: { kind: 'card_failed' } })).toBe(1);
});

it('checks at most 20 a run', async () => {
  for (let i = 0; i < 25; i++) await order({ sendState: 'review' });
  await reconciler.run(now);
  expect(stripe.lookups).toHaveLength(20);
});

it('skips the run while Stripe is cooling down', async () => {
  const { id } = await order();
  await payment(id, 'processing');
  await redis.set(cooldownKey('stripe'), '1', 'PX', 10_000);
  await reconciler.run(now);
  expect(stripe.lookups).toEqual([]);
  await redis.del(cooldownKey('stripe'));
});

it('skips a PaymentIntent Stripe cannot find and reconciles the rest', async () => {
  const missing = await order();
  await payment(missing.id, 'processing', minutesAgo(6), 'pi_missing');
  const found = await order();
  await payment(found.id, 'processing', minutesAgo(5), 'pi_found');
  stripe.stored.set(
    'pi_found',
    paymentIntent({ id: 'pi_found', status: 'succeeded', orderId: found.id }),
  );
  await reconciler.run(now);
  await reconciler.run(new Date(now.getTime() + 60 * 60_000));
  expect(
    await db().payment.findFirstOrThrow({ where: { externalKey: 'pi_found' } }),
  ).toMatchObject({ stage: 'settled' });
  const incidents = await db().incident.findMany({
    where: { kind: 'reconcile_failed' },
    include: { payment: true },
  });
  expect(incidents).toHaveLength(1);
  expect(incidents[0]?.payment?.externalKey).toBe('pi_missing');
});

it('records one incident for an order whose search Stripe refuses', async () => {
  const refused = await order({ sendState: 'review' });
  stripe.failures.set(refused.id, new RpcError('permanent'));
  await reconciler.run(now);
  await reconciler.run(new Date(now.getTime() + 60 * 60_000));
  const incidents = await db().incident.findMany({
    where: { kind: 'reconcile_failed' },
  });
  expect(incidents).toHaveLength(1);
  expect(incidents[0]?.whatHappened).toContain(refused.id);
});

it('stops the run without incidents when Stripe rejects the API key', async () => {
  const first = await order();
  await payment(first.id, 'processing', minutesAgo(6), 'pi_first');
  const second = await order();
  await payment(second.id, 'processing', minutesAgo(5), 'pi_second');
  stripe.failures.set('pi_first', new StripeAccessError('401'));
  stripe.failures.set('pi_second', new StripeAccessError('401'));
  await expect(reconciler.run(now)).rejects.toBeInstanceOf(StripeAccessError);
  expect(stripe.lookups).toHaveLength(1);
  expect(await db().incident.count()).toBe(0);
});

it('stops the run without incidents when no Stripe key is set', async () => {
  const noop = async () => undefined;
  const keyless = new SdkStripeClient(
    undefined,
    new RpcLimiter(1000, 1000, Date.now, noop, noop),
  );
  reconciler = new CardReconcilerService(database.db, keyless, redis);
  const first = await order();
  await payment(first.id, 'processing', minutesAgo(6), 'pi_first');
  const second = await order();
  await payment(second.id, 'processing', minutesAgo(5), 'pi_second');
  await expect(reconciler.run(now)).rejects.toBeInstanceOf(StripeAccessError);
  expect(await db().incident.count()).toBe(0);
});

it('stops the run on a transient Stripe error', async () => {
  const first = await order();
  await payment(first.id, 'processing', minutesAgo(6), 'pi_first');
  const second = await order();
  await payment(second.id, 'processing', minutesAgo(5), 'pi_second');
  stripe.failures.set('pi_first', new RpcError('transient'));
  stripe.stored.set(
    'pi_second',
    paymentIntent({ id: 'pi_second', status: 'succeeded', orderId: second.id }),
  );
  await expect(reconciler.run(now)).rejects.toMatchObject({
    kind: 'transient',
  });
  expect(stripe.lookups).toEqual(['pi_first']);
  expect(await db().incident.count()).toBe(0);
  expect(await db().ledgerEntry.count()).toBe(0);
});

it('reaches a newer order when 20 older ones keep finding nothing', async () => {
  for (let i = 0; i < 21; i++)
    await order({ sendState: 'review' }, minutesAgo(30 - i));
  const newer = await order({ sendState: 'review' }, minutesAgo(5));
  stripe.stored.set(
    'pi_newer',
    paymentIntent({ id: 'pi_newer', status: 'succeeded', orderId: newer.id }),
  );
  await reconciler.run(now);
  await reconciler.run(new Date(now.getTime() + 60_000));
  expect(
    (await db().order.findUniqueOrThrow({ where: { id: newer.id } })).status,
  ).toBe('paid');
});

it('backs off a payment Stripe still reports as processing', async () => {
  const { id } = await order();
  await payment(id, 'processing');
  stripe.stored.set(
    'pi_1',
    paymentIntent({ id: 'pi_1', status: 'processing', orderId: id }),
  );
  await reconciler.run(now);
  await reconciler.run(new Date(now.getTime() + 60_000));
  expect(stripe.lookups).toEqual(['pi_1']);
  await reconciler.run(new Date(now.getTime() + 10 * 60_000));
  expect(stripe.lookups).toEqual(['pi_1', 'pi_1']);
});

it('finds a charge on an order left pending after expiry', async () => {
  const left = await order({ sendState: 'pending', status: 'expired' });
  stripe.stored.set(
    'pi_left',
    paymentIntent({ id: 'pi_left', status: 'succeeded', orderId: left.id }),
  );
  await reconciler.run(now);
  expect(stripe.lookups).toEqual([left.id]);
  expect(await db().payment.findFirstOrThrow()).toMatchObject({
    externalKey: 'pi_left',
    stage: 'settled',
  });
  expect(
    await db().incident.count({ where: { kind: 'paid_after_expiry' } }),
  ).toBe(1);
});

it('counts a late settle of a scheduled order against the daily budget', async () => {
  const day = new Date('2026-10-23T00:00:00Z');
  await db().dailyBudget.create({
    data: { day, targetCount: 10, targetAmount: 10_000_000n },
  });
  const closed = await order({
    sendState: 'failed',
    status: 'expired',
    source: 'schedule',
  });
  stripe.stored.set(
    'pi_late',
    paymentIntent({ id: 'pi_late', status: 'succeeded', orderId: closed.id }),
  );
  await reconciler.run(now);
  expect(
    await db().dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 500000n });
});

it("restores a scheduled order's budget once when the same success is applied twice", async () => {
  const day = new Date('2026-10-23T00:00:00Z');
  await db().dailyBudget.create({
    data: { day, targetCount: 10, targetAmount: 10_000_000n },
  });
  const closed = await order({
    sendState: 'failed',
    status: 'expired',
    source: 'schedule',
  });
  const succeeded = paymentIntent({
    id: 'pi_late',
    status: 'succeeded',
    orderId: closed.id,
  });
  await db().$transaction((tx) => applyIntent(tx, succeeded, now));
  await db().$transaction((tx) => applyIntent(tx, succeeded, now));
  expect(
    await db().dailyBudget.findUniqueOrThrow({ where: { day } }),
  ).toMatchObject({ reservedCount: 1, reservedAmount: 500000n });
});
