import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client';
import type { PrismaService } from '../src/database.module';

export async function testDatabase(): Promise<{
  db: PrismaService;
  close: () => Promise<void>;
}> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error('TEST_DATABASE_URL is required for database tests');
  const schema = `buyer_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString() }, { schema }),
  });
  const db = Object.assign(client, {
    onModuleDestroy: async () => {
      await client.$disconnect();
    },
  });
  const migrations = join(__dirname, '../prisma/migrations');
  for (const entry of readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    for (const statement of readFileSync(
      join(migrations, entry.name, 'migration.sql'),
      'utf8',
    )
      .split(';')
      .filter((part) => part.trim()))
      await db.$executeRawUnsafe(statement);
  }
  return {
    db,
    close: async () => {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    },
  };
}
