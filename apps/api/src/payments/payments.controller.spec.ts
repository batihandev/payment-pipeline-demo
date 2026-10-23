import request from 'supertest';
import { payment as createPayment } from '../../testing/read-api';
import { useReadApi } from '../../testing/read-api';

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

it('answers 400 bad_request for an unknown or out-of-range limit', async () => {
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=abc',
    'limit=1.5',
    'other=1',
  ]) {
    const response = await get(`/payments?${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'bad_request' });
  }
});

it('serves /payments from cache for 5 s per limit', async () => {
  await payment();
  expect((await get('/payments')).body).toHaveLength(1);
  expect((await get('/payments?limit=1')).body).toHaveLength(1);
  await payment({ receivedAt: new Date('2026-10-20T13:00:00Z') });
  state.time += 4999;
  expect((await get('/payments')).body).toHaveLength(1);
  expect((await get('/payments?limit=2')).body).toHaveLength(2);
  expect((await get('/payments?limit=1')).body).toHaveLength(1);
  state.time += 1;
  expect((await get('/payments')).body).toHaveLength(2);
});
