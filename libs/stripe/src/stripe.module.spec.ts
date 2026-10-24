import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { REDIS } from '@app/redis';
import { SdkStripeClient, StripeClient } from './stripe-client';
import {
  SdkStripeEventVerifier,
  StripeEventVerifier,
} from './stripe-event-verifier';
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

it('provides the event verifier', async () => {
  const module = await build({
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    RPC_COOLDOWN_MS: 1000,
  });
  expect(module.get(StripeEventVerifier)).toBeInstanceOf(
    SdkStripeEventVerifier,
  );
});

it('starts without a secret key and fails card payments as permanent', async () => {
  const inherited = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const module = await build({ RPC_COOLDOWN_MS: 1000 });
    await expect(
      module.get(StripeClient).createPayment({
        amountCents: 52,
        customer: 'cus_1',
        paymentMethod: 'pm_1',
        orderId: 'order-1',
      }),
    ).rejects.toMatchObject({ kind: 'permanent' });
  } finally {
    if (inherited !== undefined) process.env.STRIPE_SECRET_KEY = inherited;
  }
});
