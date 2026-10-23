import { Module, type DynamicModule } from '@nestjs/common';
import { appConfig } from '../../../libs/config/src/config.module';
import { buyerSchema } from '../../../libs/config/src';
import { DatabaseModule, PrismaService } from '../../../libs/db/src';
import { BuyerRuntime, type BuyerConfig } from './runtime';
@Module({})
export class AppModule {
  static forRoot(config: BuyerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [appConfig(buyerSchema), DatabaseModule],
      providers: [
        {
          provide: BuyerRuntime,
          inject: [PrismaService],
          useFactory: (db: PrismaService) => new BuyerRuntime(db, config),
        },
      ],
    };
  }
}
