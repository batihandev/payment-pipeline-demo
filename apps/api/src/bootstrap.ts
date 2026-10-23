import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { apiSchema, validateConfig } from '../../../libs/config/src';
import { bigintReplacer } from '../../../libs/core/src/json';
import { AppModule } from './app.module';
import type { ApiConfig } from './common/api-config';

// Stripe events run to several kilobytes; the shop notice route enforces its own, smaller limit.
const MAX_BODY_BYTES = 65_536;

export const applicationOptions = { rawBody: true, logger: false } as const;

export function configureApp(
  app: NestExpressApplication,
  config: ApiConfig,
): void {
  // One proxy hop is trusted, so the client address is the entry it appended and a
  // forged leftmost X-Forwarded-For value is ignored.
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false);
  // Responses carry no X-Powered-By or ETag header.
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('json replacer', bigintReplacer);
  app.useBodyParser('json', { limit: MAX_BODY_BYTES });
  app.enableCors({
    origin: [config.WEB_ORIGIN],
    methods: ['GET', 'POST', 'OPTIONS'],
    exposedHeaders: ['Retry-After'],
  });
}

export async function createApp(): Promise<NestExpressApplication> {
  const config = validateConfig(apiSchema, process.env);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(),
    applicationOptions,
  );
  configureApp(app, config);
  return app;
}
