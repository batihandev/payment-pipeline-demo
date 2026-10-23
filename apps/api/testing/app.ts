import { getSharedConfigToken } from '@nestjs/bullmq';
import type { Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { apiSchema, validateConfig } from '../../../libs/config/src';
import { testRedisUrl } from '../../../libs/config/testing/redis';
import { AppModule } from '../src/app.module';
import { applicationOptions, configureApp } from '../src/bootstrap';

export const testOrigin = 'http://localhost:5173';

export const apiTestEnvironment = (): Record<string, string> => ({
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  REDIS_URL: testRedisUrl(),
  CHAIN_ID: '84532',
  RPC_URL: 'https://example.com',
  USDC_ADDRESS: `0x${'33'.repeat(20)}`,
  BUYER_ADDRESS: `0x${'11'.repeat(20)}`,
  SHOP_ADDRESS: `0x${'22'.repeat(20)}`,
  NOTICE_SECRET: 'test-secret'.repeat(4),
  WEB_ORIGIN: testOrigin,
});

/**
 * The API as `createApp` assembles it, with the environment set from the test defaults and
 * `environment`, and providers replaced through `override`.
 */
export async function createTestApp(
  options: {
    environment?: Record<string, string>;
    override?: (builder: TestingModuleBuilder) => void;
    controllers?: Type[];
    /** Keeps the queues' Redis keys apart from other tests'. */
    queuePrefix?: string;
  } = {},
): Promise<NestExpressApplication> {
  Object.assign(process.env, apiTestEnvironment(), options.environment);
  const builder = Test.createTestingModule({
    imports: [AppModule.forRoot()],
    controllers: options.controllers ?? [],
  });
  if (options.queuePrefix)
    builder.overrideProvider(getSharedConfigToken()).useValue({
      connection: { url: testRedisUrl() },
      prefix: options.queuePrefix,
    });
  options.override?.(builder);
  const module = await builder.compile();
  const config = validateConfig(apiSchema, process.env);
  const app =
    module.createNestApplication<NestExpressApplication>(applicationOptions);
  configureApp(app, config);
  await app.init();
  return app;
}
