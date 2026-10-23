import { Module } from '@nestjs/common';
import { NoticeSenderService } from './notice-sender.service';
import { ShopNoticesProcessor } from './shop-notices.processor';

@Module({ providers: [NoticeSenderService, ShopNoticesProcessor] })
export class NoticesModule {}
