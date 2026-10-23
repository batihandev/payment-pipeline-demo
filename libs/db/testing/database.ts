import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client';
import type { DatabasePool, PrismaService } from '../src/database.module';

/**
 * A Prisma client on a fresh schema with every migration applied. `pool` replaces the
 * driver's pool settings, for tests that depend on them.
 */
export async function testDatabase(
  pool: Partial<Omit<DatabasePool, 'connectionString'>> = {},
): Promise<{
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
    adapter: new PrismaPg(
      { ...pool, connectionString: url.toString() },
      { schema },
    ),
  });
  const db = Object.assign(client, {
    onModuleInit: async () => {},
    onModuleDestroy: async () => {
      await client.$disconnect();
    },
  });
  const migrations = join(__dirname, '../prisma/migrations');
  for (const entry of readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    for (const statement of sqlStatements(
      readFileSync(join(migrations, entry.name, 'migration.sql'), 'utf8'),
    ))
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

/**
 * Splits a migration into statements at each `;` outside a `$$` body, since the driver runs
 * one statement per call.
 */
function sqlStatements(sql: string): string[] {
  return sql
    .split(/(\$\$[\s\S]*?\$\$)/)
    .reduce<string[]>(
      (statements, part, index) => {
        if (index % 2) {
          statements[statements.length - 1] += part;
          return statements;
        }
        const [first = '', ...rest] = part.split(';');
        statements[statements.length - 1] += first;
        return [...statements, ...rest];
      },
      [''],
    )
    .filter((statement) => statement.trim());
}
