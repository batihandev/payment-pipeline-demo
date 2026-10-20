import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { trackerSchema, validateConfig } from '../../../libs/config/src';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  validateConfig(trackerSchema, process.env);
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
