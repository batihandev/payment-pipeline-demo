import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { walletAddress } from '../../../../libs/chain/src/wallet-address';
import type { BuyerConfig } from '../buyer-config';

export const BUYER_ADDRESS = Symbol('BUYER_ADDRESS');
export const SHOP_ADDRESS = Symbol('SHOP_ADDRESS');

const addressOf = (
  provide: symbol,
  key: 'BUYER_PRIVATE_KEY' | 'SHOP_PRIVATE_KEY',
): Provider => ({
  provide,
  inject: [ConfigService],
  useFactory: (config: ConfigService<BuyerConfig, true>) =>
    walletAddress(config.get(key, { infer: true })),
});

export const walletProviders: Provider[] = [
  addressOf(BUYER_ADDRESS, 'BUYER_PRIVATE_KEY'),
  addressOf(SHOP_ADDRESS, 'SHOP_PRIVATE_KEY'),
];
