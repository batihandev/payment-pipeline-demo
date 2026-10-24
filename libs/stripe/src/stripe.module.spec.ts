import { expect, it } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { RpcError } from '@app/chain/rpc-error';
import { REDIS } from '@app/redis';
import { StripeClient } from './stripe-client';
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

it('starts without a secret key and fails card payments as permanent', async () => {
  const inherited = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const module = await build({ RPC_COOLDOWN_MS: 1000 });
    const error = await module
      .get(StripeClient)
      .createPayment({
        amountCents: 52,
        customer: 'cus_1',
        paymentMethod: 'pm_1',
        orderId: 'order-1',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ kind: 'permanent' });
    expect((error as Error).message).toMatch(/STRIPE_SECRET_KEY/);
  } finally {
    if (inherited !== undefined) process.env.STRIPE_SECRET_KEY = inherited;
  }
});
