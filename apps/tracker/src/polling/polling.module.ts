import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../libs/db/src';
import { ProgressService } from '../scanning/progress.service';
import { ScannerService } from '../scanning/scanner.service';
import { ScanningModule } from '../scanning/scanning.module';
import type { TrackerConfig } from '../tracker-config';
import { PollerService } from './poller.service';

@Module({
  imports: [ScanningModule],
  providers: [
    {
      provide: PollerService,
      inject: [PrismaService, ScannerService, ProgressService, ConfigService],
      useFactory: (
        db: PrismaService,
        scanner: ScannerService,
        progress: ProgressService,
        config: ConfigService<TrackerConfig, true>,
      ) =>
        new PollerService(db, scanner, progress, {
          active: config.get('ACTIVE_POLL_MS', { infer: true }),
          idle: config.get('IDLE_POLL_MS', { infer: true }),
        }),
    },
  ],
})
export class PollingModule {}
