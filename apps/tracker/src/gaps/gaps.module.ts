import { Module } from '@nestjs/common';
import { ScanningModule } from '../scanning/scanning.module';
import { GapRecoveryService } from './gap-recovery.service';

@Module({
  imports: [ScanningModule],
  providers: [GapRecoveryService],
  exports: [GapRecoveryService],
})
export class GapsModule {}
