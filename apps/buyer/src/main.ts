import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { buyerSchema, validateConfig } from '../../../libs/config/src';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const config = validateConfig(buyerSchema, process.env);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableShutdownHooks();
  await app.listen(config.BUYER_PORT, '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
