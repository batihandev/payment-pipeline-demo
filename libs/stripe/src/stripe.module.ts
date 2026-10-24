import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Redis } from 'ioredis';
import { serviceLimiter } from '@app/chain/service-limiter';
import { REDIS } from '@app/redis';
import { SdkStripeClient, StripeClient } from './stripe-client';
import {
  SdkStripeEventVerifier,
  StripeEventVerifier,
} from './stripe-event-verifier';

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
        return new SdkStripeClient(
          key ? new Stripe(key, { maxNetworkRetries: 0 }) : undefined,
          serviceLimiter(
            redis,
            'stripe',
            // Typed by key: ConfigService's path typing drops `undefined` from optional keys.
            config.get<Settings['STRIPE_REQUESTS_PER_SECOND']>(
              'STRIPE_REQUESTS_PER_SECOND',
            ) ?? 5,
            config.get('RPC_COOLDOWN_MS', { infer: true }),
          ),
        );
      },
    },
    {
      provide: StripeEventVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Settings, true>) =>
        new SdkStripeEventVerifier(
          config.get('STRIPE_WEBHOOK_SECRET', { infer: true }),
        ),
    },
  ],
  exports: [StripeClient, StripeEventVerifier],
})
export class StripeModule {}
