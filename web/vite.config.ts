import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  envDir: '..',
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@app\/core$/,
        replacement: fileURLToPath(
          new URL('../libs/core/src', import.meta.url),
        ),
      },
      {
        find: /^@app\/core\//,
        replacement: fileURLToPath(
          new URL('../libs/core/src/', import.meta.url),
        ),
      },
    ],
  },
});
