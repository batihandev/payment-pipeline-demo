import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChainModule } from '../../../../libs/chain/src/chain.module';
import { ChainClient } from '../../../../libs/chain/src/chain-client';
import { PrismaService } from '../../../../libs/db/src';
import type { TrackerConfig } from '../tracker-config';
import { ProgressService } from './progress.service';
import { ScannerService } from './scanner.service';

@Module({
  imports: [ChainModule.forRoot({ service: 'tracker' })],
  providers: [
    {
      provide: ScannerService,
      inject: [PrismaService, ChainClient, ConfigService],
      useFactory: (
        db: PrismaService,
        chain: ChainClient,
        config: ConfigService<TrackerConfig, true>,
      ) => {
        const get = <K extends keyof TrackerConfig>(key: K) =>
          config.get(key, { infer: true });
        return new ScannerService(db, chain, {
          startBlock: get('START_BLOCK'),
          chainId: get('CHAIN_ID'),
          shop: get('SHOP_ADDRESS'),
          buyer: get('BUYER_ADDRESS'),
          maxRange: get('MAX_RANGE'),
          minRange: get('MIN_RANGE'),
          rescanBlocks: get('RESCAN_BLOCKS'),
          rpcAttempts: get('RPC_MAX_ATTEMPTS'),
          gapAttempts: get('GAP_MAX_ATTEMPTS'),
          confirmations: get('CONFIRMATIONS'),
        });
      },
    },
    {
      provide: ProgressService,
      inject: [PrismaService, ScannerService],
      useFactory: (db: PrismaService, scanner: ScannerService) =>
        new ProgressService(db, scanner),
    },
  ],
  exports: [ScannerService, ProgressService],
})
export class ScanningModule {}
