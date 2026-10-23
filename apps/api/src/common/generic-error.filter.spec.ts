import { Controller, Get, HttpException } from '@nestjs/common';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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

  @Get('coded')
  coded(): never {
    throw new ApiError(429, 'busy', { orderId: 'o1' }, { 'Retry-After': '2' });
  }
}

let app: NestFastifyApplication;
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
