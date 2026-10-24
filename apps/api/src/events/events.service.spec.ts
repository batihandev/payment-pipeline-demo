import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import {
  paymentChannel,
  publishPayment,
  serializePayment,
} from '@app/events/publish-payment';
import { orderChannel, serializeOrder } from '@app/events/order-events';
import { testDatabase } from '@testing/db/database';
import { testRedisUrl } from '@testing/config/redis';
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
  vi.useRealTimers();
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
  const chunk: unknown = (await received)[0];
  expect(String(chunk)).toMatch(/\n\n$/);
  expect(message(chunk)).toEqual({
    ...(JSON.parse(serializePayment(row)) as object),
    explorerUrl: null,
  });
  stream.destroy();
});
it('adds the explorer link to a streamed payment with a transaction', async () => {
  const stream = await connect();
  const hash = `0x${'ab'.repeat(32)}`;
  const row = await database.db.payment.create({
    data: {
      provider: 'chain',
      externalKey: 'event-explorer',
      amount: 14000731n,
      stage: 'sent',
      transactionHash: hash,
      sentAt: new Date(),
    },
  });
  const received = once(stream, 'data');
  await publishPayment(redis, row);
  expect(message((await received)[0])).toMatchObject({
    explorerUrl: `https://sepolia.basescan.org/tx/${hash}`,
  });
  stream.destroy();
});
const message = (chunk: unknown) =>
  JSON.parse(/^data: (.*)$/m.exec(String(chunk))?.[1] ?? '') as Record<
    string,
    unknown
  >;
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
  const chunk: unknown = (await received)[0];
  const message = JSON.parse(
    /^data: (.*)$/m.exec(String(chunk))?.[1] ?? '',
  ) as Record<string, unknown>;
  expect(message).not.toHaveProperty('fromAddress');
  expect(message.donorName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  expect(String(chunk)).not.toContain('ee'.repeat(20));
  stream.destroy();
});
it('sends a keep-alive comment every 30 seconds', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const stream = await connect();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(String(chunk)));
  const nextChunk = async () => {
    const count = chunks.length;
    while (chunks.length === count)
      await new Promise((resolve) => setImmediate(resolve));
    return chunks.at(-1);
  };
  vi.advanceTimersByTime(29_999);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(chunks).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(await nextChunk()).toBe(': keep-alive\n\n');
  vi.advanceTimersByTime(30_000);
  expect(await nextChunk()).toBe(': keep-alive\n\n');
  // The stream's keep-alive timer, beside the throttler's sweep.
  const timersWithStream = vi.getTimerCount();
  const closed = once(stream, 'close');
  stream.destroy();
  await closed;
  for (
    let wait = 0;
    wait < 50 && vi.getTimerCount() === timersWithStream;
    wait++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(vi.getTimerCount()).toBe(timersWithStream - 1);
});
it('relays order events to the stream as named order events', async () => {
  const stream = await connect();
  const received = once(stream, 'data');
  const id = '6f1c4a52-3a43-4c38-9a71-0c2b8f1d2e3a';
  await redis.publish(
    orderChannel,
    serializeOrder({ id, status: 'expired', sendState: 'failed' }),
  );
  const chunk: unknown = (await received)[0];
  expect(String(chunk)).toMatch(/^event: order\n(id: \d+\n)?data: (.*)\n\n$/m);
  expect(String(chunk)).toContain(
    `data: {"type":"order","id":"${id}","closed":true}\n\n`,
  );
  stream.destroy();
});
