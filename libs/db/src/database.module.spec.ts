import { expect, it, vi } from 'vitest';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DatabaseModule, PrismaService } from './database.module';

it('provides one Prisma client built from DATABASE_URL and disconnects on shutdown', async () => {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [() => ({ DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/db' })],
      }),
      DatabaseModule,
    ],
  }).compile();
  const prisma = module.get(PrismaService);
  const disconnect = vi.spyOn(prisma, '$disconnect');
  await module.close();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

it('fails at boot with an unreachable database', async () => {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [
          () => ({
            DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/db',
            DATABASE_POOL_MAX: 2,
            DATABASE_CONNECT_TIMEOUT_MS: 1000,
            DATABASE_IDLE_TIMEOUT_MS: 1000,
          }),
        ],
      }),
      DatabaseModule,
    ],
  }).compile();
  try {
    await expect(module.init()).rejects.toMatchObject({
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
    });
  } finally {
    await module.close();
  }
});
