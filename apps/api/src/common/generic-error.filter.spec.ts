import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Controller, Get, HttpException, Res } from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { appLogger } from '@app/logging';
import { createTestApp } from '../../testing/app';
import { ApiError } from './api-error';

@Controller()
class FailingController {
  @Get('fails')
  fails(): never {
    throw Object.assign(
      new Error(
        'Invalid `prisma.payment.findMany()` invocation: connection to postgresql://user:secret@db.internal failed',
      ),
      { code: 'P1001', clientVersion: '7.10.1' },
    );
  }

  @Get('leaky')
  leaky(): never {
    const error = Object.assign(
      new Error('connect to postgresql://user:secret@db.internal failed'),
      { code: 'sk_test_secret key=value' },
    );
    error.name = 'postgresql://user:secret@db.internal';
    throw error;
  }

  @Get('status-404')
  notFound(): never {
    throw new HttpException('secret detail', 404);
  }

  @Get('status-413')
  tooLarge(): never {
    throw Object.assign(new Error('secret detail'), { statusCode: 413 });
  }

  @Get('status-418')
  teapot(): never {
    throw Object.assign(new Error('secret detail'), { statusCode: 418 });
  }

  @Get('after-headers')
  afterHeaders(@Res() response: Response): never {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    throw new Error('failed after the stream started');
  }

  @Get('coded')
  coded(): never {
    throw new ApiError(429, 'busy', { orderId: 'o1' }, { 'Retry-After': '2' });
  }
}

let app: NestExpressApplication;
const errorBody = z.object({ error: z.string() });
beforeAll(async () => {
  app = await createTestApp({
    environment: { NOTICE_SECRET: 'error-test-secret'.repeat(3) },
    controllers: [FailingController],
  });
});
afterAll(async () => {
  await app.close();
});

it('answers a thrown database error with a generic 500 body', async () => {
  const response = await request(app.getHttpServer()).get('/fails');
  expect(response.statusCode).toBe(500);
  expect(response.body).toEqual({ error: 'internal' });
  expect(response.text).not.toMatch(/prisma|postgresql|secret|P1001/i);
});

it('keeps the status of a request error without echoing its message', async () => {
  const response = await request(app.getHttpServer()).get(
    '/payments?limit=999',
  );
  expect(response.statusCode).toBe(400);
  expect(response.body).toEqual({ error: 'bad_request' });
});

it('keeps the error code for each 4xx', async () => {
  const codes: Record<number, string> = {};
  for (const status of [404, 413, 418]) {
    const response = await request(app.getHttpServer()).get(
      `/status-${status}`,
    );
    expect(response.statusCode).toBe(status);
    expect(response.text).not.toMatch(/secret/);
    codes[status] = errorBody.parse(response.body).error;
  }
  expect(codes).toEqual({
    404: 'not_found',
    413: 'payload_too_large',
    418: 'bad_request',
  });
});

it('answers an unknown route with not_found', async () => {
  const response = await request(app.getHttpServer()).get('/nothing-here');
  expect(response.statusCode).toBe(404);
  expect(response.body).toEqual({ error: 'not_found' });
});

it('keeps the code, details and headers a route chose', async () => {
  const response = await request(app.getHttpServer()).get('/coded');
  expect(response.statusCode).toBe(429);
  expect(response.body).toEqual({ error: 'busy', orderId: 'o1' });
  expect(response.headers['retry-after']).toBe('2');
});

it('does not write a body after headers are sent', async () => {
  const response = await request(app.getHttpServer()).get('/after-headers');
  expect(response.statusCode).toBe(200);
  expect(response.text).toBe('data: first\n\n');
});

describe('error log', () => {
  let logged: NestExpressApplication;
  beforeAll(async () => {
    const startup = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      logged = await createTestApp({
        environment: { NOTICE_SECRET: 'error-test-secret'.repeat(3) },
        controllers: [FailingController],
        logger: appLogger(),
      });
    } finally {
      startup.mockRestore();
    }
  });
  afterAll(async () => {
    await logged.close();
  });

  async function logOf(...paths: string[]): Promise<string> {
    const output = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      for (const path of paths) await request(logged.getHttpServer()).get(path);
      return output.mock.calls.map(([chunk]) => String(chunk)).join('');
    } finally {
      output.mockRestore();
    }
  }

  it('logs a 5xx with name, code and route but not the message', async () => {
    const log = await logOf('/fails', '/status-404');
    const records: unknown[] = log
      .split('\n')
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
    expect(records).toEqual([
      {
        level: 'error',
        pid: process.pid,
        timestamp: expect.any(Number) as unknown,
        context: 'GenericErrorFilter',
        message: 'Request failed.',
        params: {
          name: 'Error',
          code: 'P1001',
          status: 500,
          route: 'GET /fails',
        },
      },
    ]);
  });

  it('logs an error after headers are sent with name, code and route but not the message', async () => {
    const log = await logOf('/after-headers');
    const records: unknown[] = log
      .split('\n')
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
    expect(records).toEqual([
      {
        level: 'error',
        pid: process.pid,
        timestamp: expect.any(Number) as unknown,
        context: 'GenericErrorFilter',
        message: 'Request failed after its response started.',
        params: { name: 'Error', route: 'GET /after-headers' },
      },
    ]);
    expect(log).not.toMatch(/stream started|stack/);
  });

  it('writes no secret-looking text to the log', async () => {
    const log = await logOf('/fails', '/leaky');
    expect(log.split('\n').filter(Boolean)).toHaveLength(2);
    expect(log).not.toMatch(/postgresql|secret|prisma|invocation|key=|stack/i);
  });
});
