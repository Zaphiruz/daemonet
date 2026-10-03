import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke against a locally running sim (port 3000) and api (port 3001) started with
 * AUTH_DEV_BYPASS=true — see OPERATIONS.md "Local development". The built client is served by
 * `vite preview`, which proxies /api and /ws to them.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:4173', headless: true, viewport: { width: 1280, height: 800 } },
  webServer: { command: 'pnpm preview', url: 'http://127.0.0.1:4173', reuseExistingServer: true, timeout: 60_000 },
});
