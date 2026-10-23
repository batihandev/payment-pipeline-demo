import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { once } from 'node:events';
import {
  paymentChannel,
  publishPayment,
  serializePayment,
} from '../../../libs/events/src/publish-payment';
import { testDatabase } from '../../../libs/db/testing/database';
import { registerEvents } from './events';
import { testRedisUrl } from '../../../libs/config/testing/redis';
let adapter: FastifyAdapter;
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
  adapter = new FastifyAdapter();
  await registerEvents(adapter.getInstance(), redis, 10000n);
});
afterEach(async () => {
  jest.useRealTimers();
  await adapter.close();
});
it('relays full published payment rows to SSE clients and releases disconnected streams', async () => {
  const response = await adapter
    .getInstance()
    .inject({ url: '/events', payloadAsStream: true });
  expect(response.headers['content-type']).toBe('text/event-stream');
  const stream = response.stream();
  const connected = once(stream, 'data');
  stream.resume();
  await connected;
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
const openStream = async () => {
  const response = await adapter
    .getInstance()
    .inject({ url: '/events', payloadAsStream: true });
  const stream = response.stream();
  const connected = once(stream, 'data');
  stream.resume();
  await connected;
  return stream;
};
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
  const stream = await openStream();
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
  const stream = await openStream();
  const chunks: string[] = [];
  stream.on('data', (chunk) => chunks.push(String(chunk)));
  await redis.publish(paymentChannel, 'not json');
  await publishPayment(redis, await donation('after-malformed', 10000n));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(chunks.join('')).toContain('"amount":"10000"');
  stream.destroy();
});
it('streams donations without the sender', async () => {
  const stream = await openStream();
  const received = once(stream, 'data');
  await publishPayment(redis, await donation('named-donation', 10000n));
  const [chunk] = await received;
  const message = JSON.parse(String(chunk).slice('data: '.length)) as Record<
    string,
    unknown
  >;
  expect(message).not.toHaveProperty('fromAddress');
  expect(message.donorName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  expect(String(chunk)).not.toContain('ee'.repeat(20));
  stream.destroy();
});
it('sends a heartbeat after fifteen seconds without payment activity', async () => {
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
  const response = await adapter
    .getInstance()
    .inject({ url: '/events', payloadAsStream: true });
  const stream = response.stream();
  const connected = once(stream, 'data');
  stream.resume();
  await connected;
  const received = once(stream, 'data');
  jest.advanceTimersByTime(15000);
  const [chunk] = await received;
  expect(String(chunk)).toContain(': heartbeat\n\n');
  stream.destroy();
});
