import { Module, type DynamicModule } from '@nestjs/common';
import { DbModule, DbService } from '../../../libs/db/src';
import { TrackerRuntime, type TrackerConfig } from './runtime';
@Module({})
export class AppModule {
  static forRoot(config: TrackerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [DbModule.forRoot(config.DATABASE_URL)],
      providers: [
        {
          provide: TrackerRuntime,
          inject: [DbService],
          useFactory: (db: DbService) => new TrackerRuntime(db, config),
        },
      ],
    };
  }
}
