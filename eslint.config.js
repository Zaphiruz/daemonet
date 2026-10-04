import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'apps/frontend/public/sandbox.html', 'apps/frontend/public/sandbox/**'] },
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Player-delivered code (browser bundle, sandbox, SDK and what they import) must never pull in the
    // evolution requirement table; `scripts/check-player-bundles.mjs` enforces the same on the builds.
    files: ['apps/frontend/**', 'packages/sdk/**', 'packages/sandbox/**', 'packages/shared/**', 'packages/sprites/**', 'examples/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@daemonet/rules/*', '**/rules/src/evolution', '**/rules/src/evolution/**'], message: 'server-only: hidden evolution requirements must not reach players' }] },
      ],
    },
  },
]);
