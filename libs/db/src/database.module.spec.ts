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
  const disconnect = jest.spyOn(prisma, '$disconnect');
  await module.close();
  expect(disconnect).toHaveBeenCalledTimes(1);
});
