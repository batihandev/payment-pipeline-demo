import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { restoreEnvironmentAfterAll } from '../testing/environment';
import { appConfig } from './config.module';
import { validateConfig } from './index';

restoreEnvironmentAfterAll();

const schema = z.object({
  DATABASE_URL: z.url(),
  LIMIT: z.coerce.number().int().default(3),
  ORIGINS: z.string().transform((value) => value.split(',')),
  OPTIONAL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional(),
  ),
});

it('serves the parsed values it is given and never reads the environment', async () => {
  const config = validateConfig(schema, {
    DATABASE_URL: 'postgres://localhost/db',
    LIMIT: '7',
    ORIGINS: 'a,b',
    OPTIONAL: '',
  });
  process.env.LIMIT = 'from the environment';
  process.env.OPTIONAL = '';
  const module = await Test.createTestingModule({
    imports: [appConfig(config)],
  }).compile();
  const service =
    module.get<ConfigService<z.output<typeof schema>, true>>(ConfigService);
  expect(service.get('LIMIT', { infer: true })).toBe(7);
  expect(service.get('ORIGINS', { infer: true })).toEqual(['a', 'b']);
  expect(service.get('OPTIONAL', { infer: true })).toBeUndefined();
  await module.close();
});
