import { ConfigModule } from '@nestjs/config';
import type { z } from 'zod';
import { validateConfig } from './index';

export function appConfig(schema: z.ZodObject) {
  return ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    validate: (environment) => validateConfig(schema, environment),
  });
}
