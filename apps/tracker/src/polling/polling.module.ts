import { Module } from '@nestjs/common';
import { ScanningModule } from '../scanning/scanning.module';
import { PollerService } from './poller.service';

@Module({ imports: [ScanningModule], providers: [PollerService] })
export class PollingModule {}
