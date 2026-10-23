import { testDatabase } from '../testing/database';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});

it('stores only the four send states on orders and sweeps', async () => {
  const { db } = database;
  const order = await db.order.create({
    data: {
      item: 'Duck',
      price: 99n,
      expectedAmount: 100n,
      source: 'visitor',
      expiresAt: new Date(Date.now() + 1_800_000),
    },
  });
  await db.sweep.create({ data: { id: 'send-state-sweep', amount: 1n } });
  for (const state of ['pending', 'sent', 'failed', 'review']) {
    await db.$executeRaw`UPDATE orders SET send_state = ${state} WHERE id = ${order.id}::uuid`;
    await db.$executeRaw`UPDATE sweeps SET send_state = ${state} WHERE id = 'send-state-sweep'`;
  }
  await expect(
    db.$executeRaw`UPDATE orders SET send_state = 'sending' WHERE id = ${order.id}::uuid`,
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE sweeps SET send_state = 'sending' WHERE id = 'send-state-sweep'`,
  ).rejects.toThrow();
});
