import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}', 'examples/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/frontend/e2e/**'],
    testTimeout: 30_000,
    // DB-backed test files TRUNCATE the shared database, so files must not run concurrently.
    fileParallelism: false,
  },
});
