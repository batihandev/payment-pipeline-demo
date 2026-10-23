import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import {
  paymentChannel,
  publishPayment,
  serializePayment,
} from '../../../../libs/events/src/publish-payment';
import {
  orderChannel,
  serializeOrder,
} from '../../../../libs/events/src/order-events';
import { testDatabase } from '../../../../libs/db/testing/database';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
import { createTestApp } from '../../testing/app';
import { openEventStream } from '../../testing/event-stream';

let app: NestExpressApplication;
let redis: Redis;
let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
  redis = new Redis(testRedisUrl());
});
afterAll(async () => {
  await redis.quit();
  await database.close();
});
beforeEach(async () => {
  app = await createTestApp({ environment: { DONATION_MIN: '10000' } });
});
afterEach(async () => {
  jest.useRealTimers();
  await app.close();
});
const connect = async (): Promise<IncomingMessage> => {
  const stream = await openEventStream(app);
  const connected = once(stream, 'data');
  await connected;
  return stream;
};
it('relays full published payment rows to SSE clients and releases disconnected streams', async () => {
  const stream = await connect();
  expect(stream.headers['content-type']).toBe('text/event-stream');
  expect(stream.headers['x-accel-buffering']).toBe('no');
  const row = await database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: 'event-test',
      amount: 14000731n,
      stage: 'sent',
      sentAt: new Date(),
    },
  });
  const received = once(stream, 'data');
  await publishPayment(redis, row);
  const [chunk] = await received;
  expect(String(chunk)).toContain(`data: ${serializePayment(row)}\n\n`);
  stream.destroy();
});
const donation = (key: string, amount: bigint) =>
  database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: key,
      amount,
      donation: true,
      fromAddress: `0x${'ee'.repeat(20)}`,
      stage: 'received',
      receivedAt: new Date(),
    },
  });
it('skips donations below DONATION_MIN on the stream', async () => {
  const stream = await connect();
  const chunks: string[] = [];
  stream.on('data', (chunk) => chunks.push(String(chunk)));
  await publishPayment(redis, await donation('small-donation', 9999n));
  await publishPayment(redis, await donation('large-donation', 10000n));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const body = chunks.join('');
  expect(body).toContain('"amount":"10000"');
  expect(body).not.toContain('"amount":"9999"');
  stream.destroy();
});
it('skips a malformed message and relays the next one', async () => {
  const stream = await connect();
  const chunks: string[] = [];
  stream.on('data', (chunk) => chunks.push(String(chunk)));
  await redis.publish(paymentChannel, 'not json');
  await publishPayment(redis, await donation('after-malformed', 10000n));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(chunks.join('')).toContain('"amount":"10000"');
  stream.destroy();
});
it('streams donations without the sender', async () => {
  const stream = await connect();
  const received = once(stream, 'data');
  await publishPayment(redis, await donation('named-donation', 10000n));
  const [chunk] = await received;
  const message = JSON.parse(
    /^data: (.*)$/m.exec(String(chunk))?.[1] ?? '',
  ) as Record<string, unknown>;
  expect(message).not.toHaveProperty('fromAddress');
  expect(message.donorName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  expect(String(chunk)).not.toContain('ee'.repeat(20));
  stream.destroy();
});
it('keeps the stream open past 15 s with a heartbeat', async () => {
  jest.useFakeTimers({
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'Date',
      'performance',
      'hrtime',
      'queueMicrotask',
    ],
  });
  const stream = await connect();
  const received = once(stream, 'data');
  jest.advanceTimersByTime(15000);
  const [chunk] = await received;
  expect(String(chunk)).toContain('event: heartbeat\n');
  stream.destroy();
});
it('relays order events to the stream as named order events', async () => {
  const stream = await connect();
  const received = once(stream, 'data');
  const id = '6f1c4a52-3a43-4c38-9a71-0c2b8f1d2e3a';
  await redis.publish(
    orderChannel,
    serializeOrder({ id, status: 'expired', sendState: 'failed' }),
  );
  const [chunk] = await received;
  expect(String(chunk)).toMatch(/^event: order\n(id: \d+\n)?data: (.*)\n\n$/m);
  expect(String(chunk)).toContain(
    `data: {"type":"order","id":"${id}","closed":true}\n\n`,
  );
  stream.destroy();
});
