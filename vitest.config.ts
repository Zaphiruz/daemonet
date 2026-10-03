import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    // DB-backed test files TRUNCATE the shared database, so files must not run concurrently.
    fileParallelism: false,
  },
});
