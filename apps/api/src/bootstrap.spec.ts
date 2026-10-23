import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, testOrigin as origin } from '../testing/app';
import { openEventStream } from '../testing/event-stream';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp({
    environment: { NOTICE_SECRET: 'cors-test-secret'.repeat(3) },
  });
});
afterAll(async () => {
  await app.close();
});
it('allows the configured web origin on payment reads', async () => {
  const response = await request(app.getHttpServer())
    .get('/payments?limit=1')
    .set('origin', origin);
  expect(response.statusCode).toBe(200);
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers.vary).toContain('Origin');
  expect(response.headers['access-control-expose-headers']).toContain(
    'Retry-After',
  );
});
it('allows browser preflight for visitor purchases from the configured origin', async () => {
  const response = await request(app.getHttpServer())
    .options('/test-purchases')
    .set('origin', origin)
    .set('access-control-request-method', 'POST')
    .set('access-control-request-headers', 'content-type');
  expect(response.statusCode).toBe(204);
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers['access-control-allow-methods']).toContain('POST');
});
it('does not grant CORS access to another origin or a similar hostname', async () => {
  for (const other of ['https://example.com', `${origin}.example.com`]) {
    const response = await request(app.getHttpServer())
      .get('/payments')
      .set('origin', other);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await request(app.getHttpServer())
      .options('/test-purchases')
      .set('origin', other)
      .set('access-control-request-method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  }
});
it('allows the configured origin to receive the live event stream', async () => {
  const response = await openEventStream(app, { origin });
  expect(response.statusCode).toBe(200);
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers['content-type']).toBe('text/event-stream');
  response.destroy();
});
