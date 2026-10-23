import { EventEmitter, once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Logger, type MessageEvent } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { EMPTY, Subject } from 'rxjs';
import { testDatabase } from '../../../../libs/db/testing/database';
import { createTestApp } from '../../testing/app';
import { openEventStream } from '../../testing/event-stream';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { StreamLimit } from './stream-limit';
import type { ApiConfig } from '../common/api-config';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});

it('drops a client that stops reading as soon as one event is left unsent', async () => {
  const events = new Subject<MessageEvent>();
  const app = await createTestApp({
    override: (builder) =>
      builder.overrideProvider(EventsService).useValue({
        stream: () => events.asObservable(),
        paymentChanged: EMPTY,
        orderChanged: EMPTY,
      }),
  });
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => {});
  try {
    const stream = await openEventStream(app);
    stream.on('error', () => {});
    await once(stream, 'data');
    stream.pause();
    const closed = new Promise((resolve) => stream.once('close', resolve));
    const data = 'x'.repeat(1_000_000);
    // Socket buffers swallow the first events; the first one that cannot be sent trips the limit.
    for (let sent = 0; sent < 100 && warn.mock.calls.length === 0; sent++) {
      events.next({ data });
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const queued = /: (\d+) character/.exec(
      String(warn.mock.calls[0]?.[0]),
    )?.[1];
    expect(Number(queued)).toBeLessThan(3_000_000);
    stream.resume();
    await closed;
  } finally {
    warn.mockRestore();
    await app.close();
  }
});

describe('stream cap', () => {
  const idle = new Subject<MessageEvent>();
  const start = (environment: Record<string, string>) =>
    createTestApp({
      environment: { TRUST_PROXY: 'true', ...environment },
      override: (builder) =>
        builder.overrideProvider(EventsService).useValue({
          stream: () => idle.asObservable(),
          paymentChanged: EMPTY,
          orderChanged: EMPTY,
        }),
    });
  const body = (response: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => resolve(text));
    });
  const from = (address: string) => ({ 'X-Forwarded-For': address });

  it('caps open streams per address and in total', async () => {
    const app = await start({ STREAMS_PER_IP: '5', STREAMS_TOTAL: '7' });
    const open: IncomingMessage[] = [];
    try {
      for (let count = 0; count < 5; count++) {
        const stream = await openEventStream(app, from('7.7.7.7'));
        expect(stream.statusCode).toBe(200);
        open.push(stream);
      }
      const refused = await openEventStream(app, from('7.7.7.7'));
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.parse(await body(refused))).toEqual({
        error: 'rate_limited',
      });
      for (const address of ['7.7.7.8', '7.7.7.9']) {
        const stream = await openEventStream(app, from(address));
        expect(stream.statusCode).toBe(200);
        open.push(stream);
      }
      const full = await openEventStream(app, from('7.7.7.10'));
      expect(full.statusCode).toBe(429);
      full.resume();
    } finally {
      for (const stream of open) stream.destroy();
      await app.close();
    }
  });

  it('frees a stream slot when the client disconnects', async () => {
    const app = await start({ STREAMS_PER_IP: '1', STREAMS_TOTAL: '5' });
    try {
      const first = await openEventStream(app, from('7.7.7.7'));
      expect(first.statusCode).toBe(200);
      const refused = await openEventStream(app, from('7.7.7.7'));
      expect(refused.statusCode).toBe(429);
      refused.resume();
      first.destroy();
      let status = 429;
      for (let attempt = 0; attempt < 50 && status === 429; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const next = await openEventStream(app, from('7.7.7.7'));
        status = next.statusCode ?? 0;
        next.destroy();
      }
      expect(status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

it('frees the slot when the request closes before the stream is subscribed', () => {
  const config = {
    get: (name: string) => (name === 'STREAMS_PER_IP' ? 1 : 10),
  } as unknown as ConfigService<ApiConfig, true>;
  const controller = new EventsController(
    {
      stream: () => EMPTY,
      paymentChanged: EMPTY,
      orderChanged: EMPTY,
    } as unknown as EventsService,
    new StreamLimit(config),
  );
  const request = Object.assign(new EventEmitter(), {
    ip: '7.7.7.7',
  }) as unknown as Request;
  controller.stream(request);
  expect(() => controller.stream(request)).toThrow();
  request.emit('close');
  expect(() => controller.stream(request)).not.toThrow();
});
