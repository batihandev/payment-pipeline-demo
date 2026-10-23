import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { payment as createPayment } from '../../testing/read-api';
import { useReadApi } from '../../testing/read-api';
import { publishPayment } from '../../../../libs/events/src/publish-payment';
import { savePaymentEvent } from '../../../../libs/events/src/save-payment-event';
import {
  encodePaymentCursor,
  paymentCursor,
} from '../../../../libs/core/src/payment-cursor';

type Payment = { id: string; sentAt: string | null; receivedAt: string | null };

const state = useReadApi();
const get = (url: string) => request(state.app.getHttpServer()).get(url);
const payment = (data = {}) => createPayment(state, data);
it('returns recent payments with safe order details, exact amounts and explorer links', async () => {
  const order = await state.database.db.order.create({
    data: {
      item: 'Duck',
      price: 14000000n,
      expectedAmount: 14000731n,
      source: 'visitor',
      expiresAt: new Date(),
      signedTransaction: 'private signed bytes',
    },
  });
  await payment({ orderId: order.id, blockNumber: 91n, confirmations: 9 });
  await payment({ receivedAt: new Date('2026-10-20T11:00:00Z') });
  const response = await get('/payments?limit=1');
  expect(response.statusCode).toBe(200);
  expect(response.body).toEqual([
    expect.objectContaining({
      amount: '14000731',
      blockNumber: '91',
      confirmations: 9,
      explorerUrl: 'https://sepolia.basescan.org/tx/0x123',
      order: expect.objectContaining({
        id: order.id,
        item: 'Duck',
        price: '14000000',
      }),
    }),
  ]);
  expect(response.text).not.toContain('signedTransaction');
});
it('shows a card payment with its receipt link and only the card brand and last 4', async () => {
  const customer = await state.database.db.customer.create({
    data: {
      name: 'Demo customer',
      stripeCustomerId: `cus_${randomUUID()}`,
      stripePaymentMethodId: 'pm_private',
      cardBrand: 'visa',
      cardLast4: '4242',
    },
  });
  const order = await state.database.db.order.create({
    data: {
      item: 'Duck',
      price: 50n,
      expectedAmount: 500000n,
      source: 'visitor',
      rail: 'card',
      customerId: customer.id,
      expiresAt: new Date(),
    },
  });
  await payment({
    provider: 'stripe',
    orderId: order.id,
    externalKey: 'pi_private',
    transactionHash: null,
    receiptUrl: 'https://pay.stripe.com/receipts/1',
  });
  const response = await get('/payments');
  expect(response.body).toEqual([
    expect.objectContaining({
      provider: 'stripe',
      receiptUrl: 'https://pay.stripe.com/receipts/1',
      explorerUrl: null,
      order: expect.objectContaining({
        id: order.id,
        customer: { cardBrand: 'visa', cardLast4: '4242' },
      }),
    }),
  ]);
  expect(response.text).not.toContain('pm_private');
  expect(response.text).not.toContain('pi_private');
  expect(response.text).not.toContain(customer.stripeCustomerId);
  expect(response.text).not.toContain('Demo customer');
  await state.database.db.order.deleteMany();
  await state.database.db.customer.deleteMany();
});
it('lists note kinds on each payment', async () => {
  const noted = await payment();
  await payment({ receivedAt: new Date('2026-10-20T11:00:00Z') });
  await state.database.db.incident.createMany({
    data: ['payment_reorg', 'duplicate', 'notice_failed', 'payment_reorg'].map(
      (kind) => ({
        kind,
        whatHappened: 'Private detail.',
        howHandled: 'Handled.',
        paymentId: noted.id,
      }),
    ),
  });
  const response = await get('/payments');
  expect(
    (response.body as { id: string; noteKinds: string[] }[]).map(
      ({ id, noteKinds }) => ({ id, noteKinds }),
    ),
  ).toEqual([
    { id: noted.id, noteKinds: ['payment_reorg'] },
    { id: expect.any(String), noteKinds: [] },
  ]);
  expect(response.text).not.toContain('Private detail.');
});
it('keeps a note however many other incidents exist', async () => {
  const older = await payment();
  await state.database.db.incident.create({
    data: {
      kind: 'paid_after_expiry',
      whatHappened: 'Late.',
      howHandled: 'Credited.',
      paymentId: older.id,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    },
  });
  await state.database.db.incident.createMany({
    data: Array.from({ length: 150 }, () => ({
      kind: 'refilled',
      whatHappened: 'Refilled.',
      howHandled: 'None.',
    })),
  });
  const response = await get('/payments');
  expect(response.body).toEqual([
    expect.objectContaining({ id: older.id, noteKinds: ['paid_after_expiry'] }),
  ]);
});
it('leaves out donations below DONATION_MIN', async () => {
  for (const amount of [9999n, 10000n]) {
    const row = await payment({
      amount,
      donation: true,
      fromAddress: `0x${'ee'.repeat(20)}`,
      settledAt: new Date('2026-10-22T08:00:08Z'),
      stage: 'notified',
    });
    await state.database.db.ledgerEntry.create({
      data: { paymentId: row.id, amount },
    });
  }
  const response = await get('/payments');
  expect(response.body).toEqual([
    expect.objectContaining({ amount: '10000', donation: true }),
  ]);
  expect((await get('/stats')).body.settledCount).toBe(1);
  const daily = (await get('/stats/daily')).body;
  expect(
    daily.find((entry: { day: string }) => entry.day === '2026-10-22').settled,
  ).toBe(1);
});
it('never returns a sender address', async () => {
  const sender = `0x${'ee'.repeat(20)}`;
  await payment({ donation: true, fromAddress: sender, amount: 20000n });
  await payment();
  const response = await get('/payments');
  const items = response.body as Record<string, unknown>[];
  expect(items).toHaveLength(2);
  for (const item of items) expect(item).not.toHaveProperty('fromAddress');
  expect(items.find((item) => item.donation)?.donorName).toMatch(/ /);
  expect(response.text).not.toContain(sender);
});
it('puts a new sent purchase ahead of older received payments', async () => {
  await payment();
  const sent = await payment({
    stage: 'sent',
    receivedAt: null,
    sentAt: new Date('2026-10-20T12:01:00Z'),
  });
  expect((await get('/payments?limit=1')).body[0].id).toBe(sent.id);
});

it('answers 400 bad_request for an out-of-range or non-integer limit', async () => {
  for (const query of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5']) {
    const response = await get(`/payments?${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'bad_request' });
  }
});
it('accepts limits up to 200', async () => {
  const at = (minute: number) =>
    new Date(Date.parse('2026-10-20T12:00:00Z') - minute * 60000);
  for (let minute = 0; minute < 201; minute++)
    await payment({ receivedAt: at(minute) });
  for (const limit of [101, 200]) {
    const response = await get(`/payments?limit=${limit}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(limit);
  }
  expect((await get('/payments?limit=201')).statusCode).toBe(400);
});
it('pages older payments with a before cursor', async () => {
  const at = (time: string) => new Date(`2026-10-20T${time}Z`);
  const newest = await payment({ receivedAt: at('12:00:00') });
  const tiedFirst = await payment({
    id: 'ffffffff-0000-4000-8000-000000000000',
    receivedAt: at('11:00:00'),
  });
  const tiedSecond = await payment({
    id: '00000000-0000-4000-8000-000000000000',
    sentAt: at('11:00:00'),
    receivedAt: at('11:00:05'),
  });
  const undated = await payment({ receivedAt: null });
  const firstPage = (await get('/payments?limit=2')).body as Payment[];
  expect(firstPage.map((p) => p.id)).toEqual([newest.id, tiedFirst.id]);
  const lastOnPage = firstPage[1];
  if (!lastOnPage) throw new Error('The first page has two payments');
  const before = encodePaymentCursor(paymentCursor(lastOnPage));
  const older = await get(`/payments?limit=2&before=${before}`);
  expect(older.statusCode).toBe(200);
  expect((older.body as Payment[]).map((p) => p.id)).toEqual([
    tiedSecond.id,
    undated.id,
  ]);
  const afterUndated = encodePaymentCursor({ at: null, id: undated.id });
  expect((await get(`/payments?before=${afterUndated}`)).body).toEqual([]);
  const added = await payment({ receivedAt: at('10:00:00') });
  expect(
    ((await get(`/payments?limit=2&before=${before}`)).body as Payment[]).map(
      (p) => p.id,
    ),
  ).toEqual([tiedSecond.id, added.id]);
});
it('rejects a malformed cursor', async () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const before of [
    'abc',
    encode({ at: 'yesterday', id: '00000000-0000-4000-8000-000000000000' }),
    encode({ at: '2026-10-20T11:00:00.000Z', id: 'not-a-uuid' }),
    encode({ at: '2026-10-20T11:00:00.000Z' }),
    encode([
      '2026-10-20T11:00:00.000Z',
      '00000000-0000-4000-8000-000000000000',
    ]),
  ]) {
    const response = await get(`/payments?before=${before}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'bad_request' });
  }
});
it('ignores unknown query parameters', async () => {
  const response = await get('/payments?other=1');
  expect(response.statusCode).toBe(200);
});

it('serves the change from a payment event on the next read, within the cache window', async () => {
  await payment();
  expect((await get('/payments')).body).toHaveLength(1);
  const added = await payment({ receivedAt: new Date('2026-10-20T13:00:00Z') });
  await publishPayment(state.redis, added);
  const deadline = Date.now() + 2000;
  let length = 1;
  while (length === 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    length = (await get('/payments')).body.length;
  }
  expect(length).toBe(2);
});
it('serves /payments from cache for 5 s per limit', async () => {
  await payment();
  expect((await get('/payments')).body).toHaveLength(1);
  expect((await get('/payments?limit=40')).body).toHaveLength(1);
  await payment({ receivedAt: new Date('2026-10-20T13:00:00Z') });
  state.time += 4999;
  expect((await get('/payments')).body).toHaveLength(1);
  expect((await get('/payments?limit=60')).body).toHaveLength(2);
  expect((await get('/payments?limit=40')).body).toHaveLength(1);
  state.time += 1;
  expect((await get('/payments')).body).toHaveLength(2);
});
it('caches only multiples of 20', async () => {
  await payment();
  for (const limit of [20, 200, 21, 1]) {
    expect((await get(`/payments?limit=${limit}`)).body).toHaveLength(1);
  }
  // Added without a payment event, so only the cache window decides what a read sees.
  await payment({ receivedAt: new Date('2026-10-20T13:00:00Z') });
  expect((await get('/payments?limit=20')).body).toHaveLength(1);
  expect((await get('/payments?limit=200')).body).toHaveLength(1);
  expect((await get('/payments?limit=21')).body).toHaveLength(2);
  expect((await get('/payments?limit=1')).body).toHaveLength(1);
  expect((await get('/payments?limit=1')).body[0].receivedAt).toBe(
    '2026-10-20T13:00:00.000Z',
  );
});
it('bumps the payment version on every update', async () => {
  const { db } = state.database;
  const created = await payment();
  const version = async () =>
    (await get('/payments?limit=1')).body[0].version as number;
  expect(await version()).toBe(0);
  await db.$transaction(async (tx) => {
    const updated = await tx.payment.update({
      where: { id: created.id },
      data: { confirmations: 1 },
    });
    await savePaymentEvent(tx, updated);
  });
  const event = await db.paymentEvent.findFirstOrThrow({
    where: { paymentId: created.id },
  });
  expect(JSON.parse(event.body)).toMatchObject({ version: 1 });
  await db.payment.updateMany({
    where: { id: created.id },
    data: { confirmations: 2 },
  });
  await db.$executeRaw`UPDATE payments SET confirmations = 3 WHERE id = ${created.id}::uuid`;
  await db.payment.upsert({
    where: { id: created.id },
    create: { ...created, id: randomUUID() },
    update: { confirmations: 4 },
  });
  expect(await version()).toBe(4);
});
