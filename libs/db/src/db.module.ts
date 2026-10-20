import {
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client';

export class DbService extends PrismaClient implements OnModuleDestroy {
  constructor(connectionString: string) {
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Module({})
export class DbModule {
  static forRoot(connectionString: string): DynamicModule {
    return {
      module: DbModule,
      providers: [
        {
          provide: DbService,
          useFactory: () => new DbService(connectionString),
        },
      ],
      exports: [DbService],
    };
  }
}
