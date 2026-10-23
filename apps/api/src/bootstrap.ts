import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { apiSchema, validateConfig } from '../../../libs/config/src';
import { AppModule } from './app.module';
import type { ApiConfig } from './common/api-config';
import { proxyTrust } from './proxy';

// Only the shop notice route takes a body, and a signed notice is far smaller than this.
const MAX_BODY_BYTES = 4096;

export const adapterFor = (config: ApiConfig): FastifyAdapter =>
  new FastifyAdapter({
    trustProxy: proxyTrust(config.TRUST_PROXY),
    bodyLimit: MAX_BODY_BYTES,
  });

export const applicationOptions = { rawBody: true, logger: false } as const;

export function configureApp(
  app: NestFastifyApplication,
  config: ApiConfig,
): void {
  app.enableCors({
    origin: [config.WEB_ORIGIN],
    methods: ['GET', 'POST', 'OPTIONS'],
    exposedHeaders: ['Retry-After'],
  });
}

export async function createApp(): Promise<NestFastifyApplication> {
  const config = validateConfig(apiSchema, process.env);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(),
    adapterFor(config),
    applicationOptions,
  );
  configureApp(app, config);
  return app;
}
