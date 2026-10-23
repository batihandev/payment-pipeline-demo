import { Module } from '@nestjs/common';
import { PrismaService } from '../../../../libs/db/src';
import { ScannerService } from '../scanning/scanner.service';
import { ScanningModule } from '../scanning/scanning.module';
import { GapRecoveryService } from './gap-recovery.service';

@Module({
  imports: [ScanningModule],
  providers: [
    {
      provide: GapRecoveryService,
      inject: [PrismaService, ScannerService],
      useFactory: (db: PrismaService, scanner: ScannerService) =>
        new GapRecoveryService(db, scanner),
    },
  ],
  exports: [GapRecoveryService],
})
export class GapsModule {}
