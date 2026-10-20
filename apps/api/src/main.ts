import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { apiSchema, validateConfig } from '../../../libs/config/src';
import { AppModule } from './app.module';
import { ApiRuntime } from './runtime';

async function bootstrap(): Promise<void> {
  const config = validateConfig(apiSchema, process.env);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter(),
  );
  app.get(ApiRuntime).register(app.getHttpAdapter().getInstance());
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
