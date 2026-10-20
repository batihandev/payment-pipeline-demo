import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'libs/db/prisma/schema.prisma',
  migrations: { path: 'libs/db/prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
