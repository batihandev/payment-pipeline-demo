import {
  Global,
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client';

export type DatabaseConfig = {
  DATABASE_URL: string;
  DATABASE_POOL_MAX: number;
  DATABASE_CONNECT_TIMEOUT_MS: number;
  DATABASE_IDLE_TIMEOUT_MS: number;
};

export type DatabasePool = {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
};

/** The PostgreSQL pool settings an app's Prisma client runs with. */
export function databasePool(config: DatabaseConfig): DatabasePool {
  return {
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService<DatabaseConfig, true>) {
    super({
      adapter: new PrismaPg(
        databasePool({
          DATABASE_URL: config.get('DATABASE_URL', { infer: true }),
          DATABASE_POOL_MAX: config.get('DATABASE_POOL_MAX', { infer: true }),
          DATABASE_CONNECT_TIMEOUT_MS: config.get(
            'DATABASE_CONNECT_TIMEOUT_MS',
            { infer: true },
          ),
          DATABASE_IDLE_TIMEOUT_MS: config.get('DATABASE_IDLE_TIMEOUT_MS', {
            infer: true,
          }),
        }),
      ),
    });
  }

  /**
   * Runs one query at boot, so a bad `DATABASE_URL` stops the app at start. With a driver
   * adapter, `$connect` alone opens no connection.
   */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class DatabaseModule {}
