import { Redis } from 'ioredis';
import { cooldownKey } from '../../../../libs/chain/src/service-limiter';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import { testDatabase } from '../../../../libs/db/testing/database';
import {
  FakeStripe,
  paymentIntent,
} from '../../../../libs/stripe/testing/fake-stripe';
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
    'TRUNCATE payments, orders, incidents CASCADE',
  );
  await redis.del(cooldownKey('stripe'));
  stripe = new FakeStripe();
  reconciler = new CardReconcilerService(database.db, stripe, redis);
});

const db = () => database.db;

function order(
  data: { sendState?: string; status?: 'open' | 'expired' } = {},
  createdAt = minutesAgo(10),
) {
  return db().order.create({
    data: {
      item: 'Lucky paperclip',
      price: 500000n,
      expectedAmount: 500000n,
      source: 'visitor',
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
) {
  return db().payment.create({
    data: {
      provider: 'stripe',
      externalKey: 'pi_1',
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
