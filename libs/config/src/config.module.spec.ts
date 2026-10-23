import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { appConfig } from './config.module';

const schema = z.object({
  DATABASE_URL: z.url(),
  LIMIT: z.coerce.number().int().default(3),
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.LIMIT;
});

it('rejects an invalid environment with the variable names', async () => {
  process.env.DATABASE_URL = 'not a url';
  await expect(
    Test.createTestingModule({ imports: [appConfig(schema)] }).compile(),
  ).rejects.toThrow('Invalid or missing environment variables: DATABASE_URL');
});

it('serves validated values with their parsed types', async () => {
  process.env.DATABASE_URL = 'postgres://localhost/db';
  process.env.LIMIT = '7';
  const module = await Test.createTestingModule({
    imports: [appConfig(schema)],
  }).compile();
  const config =
    module.get<ConfigService<z.output<typeof schema>, true>>(ConfigService);
  expect(config.get('LIMIT', { infer: true })).toBe(7);
  await module.close();
});
