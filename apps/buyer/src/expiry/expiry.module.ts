import { Module } from '@nestjs/common';
import { ExpiryService } from './expiry.service';

@Module({ providers: [ExpiryService], exports: [ExpiryService] })
export class ExpiryModule {}
