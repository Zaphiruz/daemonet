import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/frontend/e2e/**'],
    testTimeout: 30_000,
    // Several suites share the one PostgreSQL in DATABASE_URL and truncate it; keep files sequential.
    fileParallelism: false,
  },
});
