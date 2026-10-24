import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Controller, Get } from '@nestjs/common';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../../testing/app';
import { ClientIp } from './client-ip';

@Controller()
class AddressController {
  @Get('address')
  address(@ClientIp() address: string) {
    return { address };
  }
}

let app: NestExpressApplication;
afterEach(async () => {
  await app.close();
});
const start = async (header: string) => {
  app = await createTestApp({
    environment: { CLIENT_IP_HEADER: header },
    controllers: [AddressController],
  });
};
const addressFor = async (headers: Record<string, string>) =>
  z
    .object({ address: z.string() })
    .parse(
      (await request(app.getHttpServer()).get('/address').set(headers)).body,
    ).address;

it('takes the client address from CF-Connecting-IP', async () => {
  await start('cf-connecting-ip');
  expect(await addressFor({ 'CF-Connecting-IP': '203.0.113.7' })).toBe(
    '203.0.113.7',
  );
  expect(await addressFor({ 'CF-Connecting-IP': '2001:db8::7' })).toBe(
    '2001:db8::7',
  );
});

it('ignores a forged X-Forwarded-For', async () => {
  await start('cf-connecting-ip');
  expect(
    await addressFor({
      'X-Forwarded-For': '198.51.100.9, 198.51.100.10',
      'CF-Connecting-IP': '203.0.113.7',
    }),
  ).toBe('203.0.113.7');
  expect(await addressFor({ 'X-Forwarded-For': '198.51.100.9' })).toBe(
    '127.0.0.1',
  );
  expect(await addressFor({ 'CF-Connecting-IP': 'not an address' })).toBe(
    '127.0.0.1',
  );
});

it('uses the socket address when no client header is configured', async () => {
  await start('');
  expect(
    await addressFor({
      'CF-Connecting-IP': '203.0.113.7',
      'X-Forwarded-For': '198.51.100.9',
    }),
  ).toBe('127.0.0.1');
});
