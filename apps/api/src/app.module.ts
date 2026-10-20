import { Module, type DynamicModule } from '@nestjs/common';
import { DbModule, DbService } from '../../../libs/db/src';
import { ApiRuntime } from './runtime';
import type { ApiConfig } from './reads';
@Module({})
export class AppModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [DbModule.forRoot(config.DATABASE_URL)],
      providers: [
        {
          provide: ApiRuntime,
          inject: [DbService],
          useFactory: (db: DbService) => new ApiRuntime(db, config),
        },
      ],
    };
  }
}
