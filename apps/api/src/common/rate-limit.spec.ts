import { Controller, Get } from '@nestjs/common';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../../testing/app';

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return { ok: true };
  }

  @Get('pong')
  pong() {
    return { ok: true };
  }
}

let app: NestExpressApplication;
afterEach(async () => {
  await app.close();
});
const start = async (environment: Record<string, string>) => {
  app = await createTestApp({
    environment: { API_REQUESTS_PER_MINUTE: '3', ...environment },
    controllers: [PingController],
  });
};

it('limits one address to API_REQUESTS_PER_MINUTE', async () => {
  await start({});
  const server = app.getHttpServer();
  for (const path of ['/ping', '/pong', '/ping'])
    expect((await request(server).get(path)).statusCode).toBe(200);
  const refused = await request(server).get('/pong');
  expect(refused.statusCode).toBe(429);
  expect(refused.body).toEqual({ error: 'rate_limited' });
  expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
});

it('does not throttle signed shop notices', async () => {
  await start({});
  const server = app.getHttpServer();
  for (let sent = 0; sent < 6; sent++) {
    const response = await request(server)
      .post('/shop/notices')
      .set('content-type', 'application/json')
      .send('{}');
    expect(response.statusCode).not.toBe(429);
  }
  expect((await request(server).get('/ping')).statusCode).toBe(200);
});

it('counts the proxy-appended address, not a forged one', async () => {
  await start({ TRUST_PROXY: 'true', API_REQUESTS_PER_MINUTE: '2' });
  const server = app.getHttpServer();
  const from = (forwarded: string) =>
    request(server).get('/ping').set('X-Forwarded-For', forwarded);
  expect((await from('1.1.1.1, 9.9.9.9')).statusCode).toBe(200);
  expect((await from('2.2.2.2, 9.9.9.9')).statusCode).toBe(200);
  expect((await from('3.3.3.3, 9.9.9.9')).statusCode).toBe(429);
  expect((await from('3.3.3.3, 8.8.8.8')).statusCode).toBe(200);
});
