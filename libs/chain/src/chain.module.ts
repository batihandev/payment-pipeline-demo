import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { apiSchema, buyerSchema, trackerSchema } from '../../config/src';
import type { z } from 'zod';
import { REDIS } from '../../redis/src';
import {
  ChainClient,
  TransferSigner,
  type Address,
  type Hex,
} from './chain-client';
import { BUYER_ADDRESS, SHOP_ADDRESS, walletAddress } from './wallet-addresses';
import { serviceLimiter } from './service-limiter';
import { ViemChainClient } from './viem-client';

type Service = 'buyer' | 'tracker' | 'api';
type Settings = z.output<typeof buyerSchema> &
  z.output<typeof trackerSchema> &
  z.output<typeof apiSchema>;

const rateKey = {
  buyer: 'RPC_REQUESTS_PER_SECOND_BUYER',
  tracker: 'RPC_REQUESTS_PER_SECOND_TRACKER',
  api: 'RPC_REQUESTS_PER_SECOND_API',
} as const;

function viemClient(
  service: Service,
  config: ConfigService<Settings, true>,
  redis: Redis,
  walletShop: Address | undefined,
): ViemChainClient {
  const get = <K extends keyof Settings>(key: K): Settings[K] =>
    config.get(key, { infer: true });
  const keys =
    service === 'buyer'
      ? [get('BUYER_PRIVATE_KEY') as Hex, get('SHOP_PRIVATE_KEY') as Hex]
      : undefined;
  const shopAddress =
    walletShop ??
    (service === 'tracker' ? (get('SHOP_ADDRESS') as Address) : undefined);
  return new ViemChainClient(
    {
      chainId: get('CHAIN_ID'),
      rpcUrl: get('RPC_URL'),
      usdcAddress: get('USDC_ADDRESS') as Address,
      ...(shopAddress && { shopAddress }),
      ...(keys && { keys }),
    },
    serviceLimiter(
      redis,
      service,
      get(rateKey[service]),
      get('RPC_COOLDOWN_MS'),
    ),
  );
}

const walletAddressProvider = (
  provide: symbol,
  key: 'BUYER_PRIVATE_KEY' | 'SHOP_PRIVATE_KEY',
): Provider => ({
  provide,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Settings, true>) =>
    walletAddress(config.get(key, { infer: true })),
});

@Module({})
export class ChainModule {
  static forRoot(options: { service: Service }): DynamicModule {
    const providers: Provider[] = [
      {
        provide: ViemChainClient,
        inject: [ConfigService, REDIS, { token: SHOP_ADDRESS, optional: true }],
        useFactory: (
          config: ConfigService<Settings, true>,
          redis: Redis,
          shop: Address | undefined,
        ) => viemClient(options.service, config, redis, shop),
      },
      { provide: ChainClient, useExisting: ViemChainClient },
    ];
    if (options.service === 'buyer')
      providers.push(
        { provide: TransferSigner, useExisting: ViemChainClient },
        walletAddressProvider(BUYER_ADDRESS, 'BUYER_PRIVATE_KEY'),
        walletAddressProvider(SHOP_ADDRESS, 'SHOP_PRIVATE_KEY'),
      );
    return {
      module: ChainModule,
      providers,
      exports: providers.map((provider) =>
        'provide' in provider ? provider.provide : provider,
      ),
    };
  }
}
