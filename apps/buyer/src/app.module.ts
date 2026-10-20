import { Module, type DynamicModule } from '@nestjs/common';
import { DbModule, DbService } from '../../../libs/db/src';
import { BuyerRuntime, type BuyerConfig } from './runtime';
@Module({})
export class AppModule {
  static forRoot(config: BuyerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [DbModule.forRoot(config.DATABASE_URL)],
      providers: [
        {
          provide: BuyerRuntime,
          inject: [DbService],
          useFactory: (db: DbService) => new BuyerRuntime(db, config),
        },
      ],
    };
  }
}
