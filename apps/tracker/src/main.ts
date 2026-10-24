import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { trackerSchema, validateConfig } from '@app/config';
import { appLogger, logStartupFailure } from '@app/logging';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const config = validateConfig(trackerSchema, process.env);
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot(config),
    { logger: appLogger(), abortOnError: false },
  );
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  logStartupFailure(error);
  process.exitCode = 1;
});
