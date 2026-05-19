import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@workers': resolve(__dirname, 'workers'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Unit tests today; integration tests that need Postgres go in
    // tests/integration/ when those land.
    pool: 'threads',
    isolate: true,
  },
});
