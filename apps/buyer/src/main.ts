import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { buyerSchema, validateConfig } from '../../../libs/config/src';
import { appLogger, logStartupFailure } from '../../../libs/logging/src';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const config = validateConfig(buyerSchema, process.env);
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot(config),
    { logger: appLogger() },
  );
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  logStartupFailure(error);
  process.exitCode = 1;
});
