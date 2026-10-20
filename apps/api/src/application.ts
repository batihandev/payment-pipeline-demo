import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ApiRuntime } from './runtime';
import type { ApiConfig } from './reads';
export async function createApi(
  config: ApiConfig,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter(),
    { rawBody: true, logger: false },
  );
  app.enableCors({
    origin: [config.WEB_ORIGIN],
    methods: ['GET', 'POST', 'OPTIONS'],
    exposedHeaders: ['Retry-After'],
  });
  await app.get(ApiRuntime).register(app.getHttpAdapter().getInstance());
  return app;
}
