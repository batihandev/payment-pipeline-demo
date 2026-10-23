import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { apiSchema, validateConfig } from '../../../libs/config/src';
import { bigintReplacer } from '../../../libs/core/src/json';
import { appLogger } from '../../../libs/logging/src';
import { AppModule } from './app.module';
import type { ApiConfig } from './common/api-config';
import { CLIENT_IP_HEADER_SETTING } from './common/client-ip';

const MAX_BODY_BYTES = 4096;
// Stripe events run to several kilobytes.
const MAX_STRIPE_EVENT_BYTES = 65_536;
const STRIPE_WEBHOOKS = '/stripe/webhooks';

const isStripeEvent = (request: IncomingMessage): boolean =>
  request.url?.split('?')[0] === STRIPE_WEBHOOKS &&
  /^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '');

export const applicationOptions = { rawBody: true } as const;

export function configureApp(
  app: NestExpressApplication,
  config: ApiConfig,
): void {
  app.set(CLIENT_IP_HEADER_SETTING, config.CLIENT_IP_HEADER);
  // Responses carry no X-Powered-By or ETag header.
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('json replacer', bigintReplacer);
  // The first parser to read a body wins, so Stripe events get the larger limit.
  app.useBodyParser('json', {
    limit: MAX_STRIPE_EVENT_BYTES,
    type: isStripeEvent,
  });
  app.useBodyParser('json', { limit: MAX_BODY_BYTES });
  app.useBodyParser('urlencoded', { limit: MAX_BODY_BYTES, extended: false });
  app.enableCors({
    origin: config.WEB_ORIGIN,
    methods: ['GET', 'POST', 'OPTIONS'],
    exposedHeaders: ['Retry-After'],
  });
}

export async function createApp(): Promise<NestExpressApplication> {
  const config = validateConfig(apiSchema, process.env);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config),
    { ...applicationOptions, logger: appLogger() },
  );
  configureApp(app, config);
  return app;
}
