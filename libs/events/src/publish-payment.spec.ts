import { Redis } from 'ioredis';
import { testDatabase } from '../../db/testing/database';
import { paymentChannel, publishPayment } from './publish-payment';
import { testRedisUrl } from '../../config/testing/redis';

it('publishes the complete saved payment with integer amounts encoded as decimal strings', async () => {
  const database = await testDatabase();
  const publisher = new Redis(testRedisUrl());
  const subscriber = new Redis(testRedisUrl());
  try {
    const row = await database.db.payment.create({
      data: {
        provider: 'chain',
        externalKey: 'sent:order',
        amount: 14000731n,
        stage: 'sent',
        transactionHash: '0x1234',
        sentAt: new Date('2026-10-20T12:00:00Z'),
      },
    });
    await subscriber.subscribe(paymentChannel);
    const delivered = new Promise<string>((resolve) =>
      subscriber.once('message', (_channel, message: string) =>
        resolve(message),
      ),
    );
    await publishPayment(publisher, row);
    const message = JSON.parse(await delivered) as Record<string, unknown>;
    expect(message).toMatchObject({
      id: row.id,
      amount: '14000731',
      stage: 'sent',
      sentAt: '2026-10-20T12:00:00.000Z',
      transactionHash: '0x1234',
      final: false,
    });
    expect(Object.keys(message).sort()).toEqual(
      [
        ...Object.keys(row).filter(
          (key) => key !== 'fromAddress' && key !== 'reconciledAt',
        ),
        'donorName',
      ].sort(),
    );
  } finally {
    await subscriber.quit();
    await publisher.quit();
    await database.close();
  }
});
