import { Module, type DynamicModule } from '@nestjs/common';
import { appConfig } from '../../../libs/config/src/config.module';
import { trackerSchema } from '../../../libs/config/src';
import { DatabaseModule, PrismaService } from '../../../libs/db/src';
import { TrackerRuntime, type TrackerConfig } from './runtime';
@Module({})
export class AppModule {
  static forRoot(config: TrackerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [appConfig(trackerSchema), DatabaseModule],
      providers: [
        {
          provide: TrackerRuntime,
          inject: [PrismaService],
          useFactory: (db: PrismaService) => new TrackerRuntime(db, config),
        },
      ],
    };
  }
}
