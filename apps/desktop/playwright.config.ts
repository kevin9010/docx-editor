import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const appRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './tests/layout',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:1421',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm --filter superdoc-desktop preview --port 1421',
    cwd: path.resolve(appRoot, '../..'),
    url: 'http://127.0.0.1:1421',
  },
});
