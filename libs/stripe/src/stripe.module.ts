import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Redis } from 'ioredis';
import { serviceLimiter } from '../../chain/src/service-limiter';
import { REDIS } from '../../redis/src';
import { SdkStripeClient, StripeClient } from './stripe-client';

type Settings = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_REQUESTS_PER_SECOND?: number;
  RPC_COOLDOWN_MS: number;
};

@Module({
  providers: [
    {
      provide: StripeClient,
      inject: [ConfigService, REDIS],
      useFactory: (config: ConfigService<Settings, true>, redis: Redis) => {
        const key = config.get('STRIPE_SECRET_KEY', { infer: true });
        if (!key) throw new Error('STRIPE_SECRET_KEY is required');
        return new SdkStripeClient(
          new Stripe(key, { maxNetworkRetries: 0 }),
          config.get('STRIPE_WEBHOOK_SECRET', { infer: true }),
          serviceLimiter(
            redis,
            'stripe',
            config.get('STRIPE_REQUESTS_PER_SECOND', { infer: true }) ?? 5,
            config.get('RPC_COOLDOWN_MS', { infer: true }),
          ),
        );
      },
    },
  ],
  exports: [StripeClient],
})
export class StripeModule {}
