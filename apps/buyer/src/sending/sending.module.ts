import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { ChainModule } from '../../../../libs/chain/src/chain.module';
import {
  ChainClient,
  TransferSigner,
  type Address,
} from '../../../../libs/chain/src/chain-client';
import { PrismaService } from '../../../../libs/db/src';
import { REDIS } from '../../../../libs/redis/src';
import type { BuyerConfig } from '../buyer-config';
import { FundsService } from './funds.service';
import { OrderSenderService } from './order-sender.service';
import { RedisLock } from './redis-lock';
import { BUYER_ADDRESS, SHOP_ADDRESS, walletProviders } from './wallets';

@Module({
  imports: [ChainModule.forRoot({ service: 'buyer' })],
  providers: [
    ...walletProviders,
    {
      provide: RedisLock,
      inject: [REDIS],
      useFactory: (redis: Redis) => new RedisLock(redis),
    },
    {
      provide: OrderSenderService,
      inject: [
        PrismaService,
        ChainClient,
        TransferSigner,
        RedisLock,
        BUYER_ADDRESS,
        SHOP_ADDRESS,
        ConfigService,
      ],
      useFactory: (
        db: PrismaService,
        chain: ChainClient,
        signer: TransferSigner,
        lock: RedisLock,
        buyer: Address,
        shop: Address,
        config: ConfigService<BuyerConfig, true>,
      ) =>
        new OrderSenderService(db, chain, signer, lock, {
          buyer,
          shop,
          chainId: config.get('CHAIN_ID', { infer: true }),
        }),
    },
    {
      provide: FundsService,
      inject: [PrismaService, ChainClient, BUYER_ADDRESS],
      useFactory: (db: PrismaService, chain: ChainClient, buyer: Address) =>
        new FundsService(db, chain, buyer),
    },
  ],
  exports: [
    OrderSenderService,
    FundsService,
    ChainModule,
    BUYER_ADDRESS,
    SHOP_ADDRESS,
  ],
})
export class SendingModule {}
