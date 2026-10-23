import { Controller, Get, HttpException, Res } from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
    codes[status] = response.body.error;
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
