import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['{apps,libs}/**/*.spec.ts'],
    // Database and Redis specs share one PostgreSQL instance and one Redis database.
    fileParallelism: false,
  },
});
