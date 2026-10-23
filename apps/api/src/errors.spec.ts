import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiSchema } from '../../../libs/config/src';
import { testRedisUrl } from '../../../libs/config/testing/redis';
import { createApi } from './application';

let app: NestFastifyApplication;
beforeAll(async () => {
  app = await createApi(
    apiSchema.parse({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      REDIS_URL: testRedisUrl(),
      CHAIN_ID: 84532,
      RPC_URL: 'https://example.com',
      USDC_ADDRESS: `0x${'33'.repeat(20)}`,
      BUYER_ADDRESS: `0x${'11'.repeat(20)}`,
      SHOP_ADDRESS: `0x${'22'.repeat(20)}`,
      NOTICE_SECRET: 'error-test-secret'.repeat(3),
      WEB_ORIGIN: 'http://localhost:5173',
    }),
  );
  app
    .getHttpAdapter()
    .getInstance()
    .get('/fails', async () => {
      throw Object.assign(
        new Error(
          'Invalid `prisma.payment.findMany()` invocation: connection to postgresql://user:secret@db.internal failed',
        ),
        { code: 'P1001', clientVersion: '7.10.1' },
      );
    });
  for (const statusCode of [404, 413, 418]) {
    app
      .getHttpAdapter()
      .getInstance()
      .get(`/status-${statusCode}`, async () => {
        throw Object.assign(new Error('secret detail'), { statusCode });
      });
  }
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app.close();
});

it('answers a thrown database error with a generic 500 body', async () => {
  const response = await app.inject({ url: '/fails' });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ error: 'internal' });
  expect(response.body).not.toMatch(/prisma|postgresql|secret|P1001/i);
});

it('keeps the status of a request error without echoing its message', async () => {
  const response = await app.inject({ url: '/payments?limit=999' });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'bad_request' });
});

it('keeps the error code for each 4xx', async () => {
  const codes: Record<number, string> = {};
  for (const status of [404, 413, 418]) {
    const response = await app.inject({ url: `/status-${status}` });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toMatch(/secret/);
    codes[status] = response.json<{ error: string }>().error;
  }
  expect(codes).toEqual({
    404: 'not_found',
    413: 'payload_too_large',
    418: 'bad_request',
  });
});
