import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../libs/db/src';
import type { TrackerConfig } from '../tracker-config';
import { NoticeSenderService } from './notice-sender.service';
import { ShopNoticesProcessor } from './shop-notices.processor';

@Module({
  providers: [
    {
      provide: NoticeSenderService,
      inject: [PrismaService, ConfigService],
      useFactory: (
        db: PrismaService,
        config: ConfigService<TrackerConfig, true>,
      ) =>
        new NoticeSenderService(db, {
          url: config.get('SHOP_NOTICE_URL', { infer: true }),
          secret: config.get('NOTICE_SECRET', { infer: true }),
        }),
    },
    ShopNoticesProcessor,
  ],
})
export class NoticesModule {}
