import { Module, type DynamicModule } from '@nestjs/common';
import { appConfig } from '../../../libs/config/src/config.module';
import { apiSchema } from '../../../libs/config/src';
import { DatabaseModule, PrismaService } from '../../../libs/db/src';
import { ApiRuntime } from './runtime';
import type { ApiConfig } from './reads';
@Module({})
export class AppModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [appConfig(apiSchema), DatabaseModule],
      providers: [
        {
          provide: ApiRuntime,
          inject: [PrismaService],
          useFactory: (db: PrismaService) => new ApiRuntime(db, config),
        },
      ],
    };
  }
}
