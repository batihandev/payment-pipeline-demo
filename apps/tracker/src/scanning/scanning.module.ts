import { Module } from '@nestjs/common';
import { ChainModule } from '@app/chain/chain.module';
import { ProgressService } from './progress.service';
import { ScannerService } from './scanner.service';

@Module({
  imports: [ChainModule.forRoot({ service: 'tracker' })],
  providers: [ScannerService, ProgressService],
  exports: [ScannerService, ProgressService],
})
export class ScanningModule {}
