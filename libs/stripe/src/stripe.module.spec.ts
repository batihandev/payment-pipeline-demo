import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { REDIS } from '../../redis/src';
import { SdkStripeClient, StripeClient } from './stripe-client';
import { StripeModule } from './stripe.module';

@Global()
@Module({
  providers: [{ provide: REDIS, useValue: {} }],
  exports: [REDIS],
})
class FakeRedisModule {}

const build = (settings: Record<string, unknown>) =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [() => settings],
      }),
      FakeRedisModule,
      StripeModule,
    ],
  }).compile();

it('provides the Stripe client', async () => {
  const module = await build({
    STRIPE_SECRET_KEY: 'sk_test_unused',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_REQUESTS_PER_SECOND: 5,
    RPC_COOLDOWN_MS: 1000,
  });
  expect(module.get(StripeClient)).toBeInstanceOf(SdkStripeClient);
});

it('does not start without a secret key', async () => {
  const inherited = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    await expect(build({ RPC_COOLDOWN_MS: 1000 })).rejects.toThrow(
      'STRIPE_SECRET_KEY is required',
    );
  } finally {
    if (inherited !== undefined) process.env.STRIPE_SECRET_KEY = inherited;
  }
});
