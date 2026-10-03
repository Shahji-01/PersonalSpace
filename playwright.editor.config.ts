import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/editor',
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:5179',
    viewport: { width: 390, height: 844 },
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: {
    command: 'pnpm exec tsx tests/editor/server.ts',
    url: 'http://127.0.0.1:5179',
    reuseExistingServer: false,
  },
});
