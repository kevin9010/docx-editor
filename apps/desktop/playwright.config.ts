import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
// Preview tooling can own the server locally; CI keeps the built-app server.
const externalServer = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './tests/layout',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: externalServer ?? 'http://127.0.0.1:1421',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    screenshot: 'only-on-failure',
  },
  webServer: externalServer ? undefined : {
    command: 'pnpm --filter superdoc-desktop preview --port 1421',
    cwd: path.resolve(appRoot, '../..'),
    url: 'http://127.0.0.1:1421',
  },
});
