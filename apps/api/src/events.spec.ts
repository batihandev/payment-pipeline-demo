import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { once } from 'node:events';
import { publishPayment } from '../../../libs/events/src/publish-payment';
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
  await registerEvents(adapter.getInstance(), redis);
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
  expect(String(chunk)).toContain(
    `data: ${JSON.stringify(row, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))}\n\n`,
  );
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
