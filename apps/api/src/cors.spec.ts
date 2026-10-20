import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiSchema } from '../../../libs/config/src';
import { createApi } from './application';
let app: NestFastifyApplication;
const origin = 'http://localhost:5173';
beforeAll(async () => {
  app = await createApi(
    apiSchema.parse({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:56379',
      CHAIN_ID: 84532,
      RPC_URL: 'https://example.com',
      USDC_ADDRESS: `0x${'33'.repeat(20)}`,
      BUYER_ADDRESS: `0x${'11'.repeat(20)}`,
      SHOP_ADDRESS: `0x${'22'.repeat(20)}`,
      NOTICE_SECRET: 'cors-test-secret'.repeat(3),
      WEB_ORIGIN: origin,
    }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app.close();
});
it('allows the configured web origin on payment reads', async () => {
  const response = await app.inject({
    url: '/payments?limit=1',
    headers: { origin },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers.vary).toContain('Origin');
  expect(response.headers['access-control-expose-headers']).toContain(
    'Retry-After',
  );
});
it('allows browser preflight for visitor purchases from the configured origin', async () => {
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/test-purchases',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  expect(response.statusCode).toBe(204);
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers['access-control-allow-methods']).toContain('POST');
});
it('does not grant CORS access to another origin or a similar hostname', async () => {
  for (const other of ['https://example.com', `${origin}.example.com`]) {
    const response = await app.inject({
      url: '/payments',
      headers: { origin: other },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/test-purchases',
      headers: { origin: other, 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  }
});
it('allows the configured origin to receive the live event stream', async () => {
  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({ url: '/events', headers: { origin }, payloadAsStream: true });
  expect(response.statusCode).toBe(200);
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers['content-type']).toBe('text/event-stream');
  response.stream().destroy();
});
