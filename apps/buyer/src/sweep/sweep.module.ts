import { Module } from '@nestjs/common';
import { SendingModule } from '../sending/sending.module';
import { SweepService } from './sweep.service';

@Module({
  imports: [SendingModule],
  providers: [SweepService],
  exports: [SweepService],
})
export class SweepModule {}
