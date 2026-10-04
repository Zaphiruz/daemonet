import { defineConfig } from '@playwright/test';

const external = process.env.E2E_BASE_URL;

/**
 * End-to-end smoke against a locally running sim (port 3000) and api (port 3001) started with
 * AUTH_DEV_BYPASS=true and one shared REDIS_URL (the org step needs the sim and the api on the same bus) — see OPERATIONS.md "Local development". The built client is served by
 * `vite preview`, which proxies /api and /ws to them. With E2E_BASE_URL set (CI), nothing is started:
 * the run targets that URL, i.e. the production frontend image (Caddy with the production CSP headers).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: external ?? 'http://127.0.0.1:4173', headless: true, viewport: { width: 1280, height: 800 } },
  webServer: external ? undefined : { command: 'pnpm preview', url: 'http://127.0.0.1:4173', reuseExistingServer: true, timeout: 60_000 },
});
