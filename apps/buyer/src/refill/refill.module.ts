import { Module } from '@nestjs/common';
import { SendingModule } from '../sending/sending.module';
import { RefillService } from './refill.service';

@Module({
  imports: [SendingModule],
  providers: [RefillService],
  exports: [RefillService],
})
export class RefillModule {}
