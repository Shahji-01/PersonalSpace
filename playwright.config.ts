import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/web',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-width', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'pnpm --filter @personalspace/web exec next start --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
