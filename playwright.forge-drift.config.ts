import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['forge-drift-gate.spec.ts'],
  timeout: 30000,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8090',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node scripts/serve-audit.mjs',
    url: 'http://127.0.0.1:8090/login',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
});
