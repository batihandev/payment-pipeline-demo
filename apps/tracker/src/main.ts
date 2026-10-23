import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot());
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
