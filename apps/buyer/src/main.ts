import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { buyerSchema, validateConfig } from '../../../libs/config/src';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const config = validateConfig(buyerSchema, process.env);
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot(config),
  );
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
