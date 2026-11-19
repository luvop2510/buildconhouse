import { defineConfig, devices } from '@playwright/test';

const port = 8196;
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'sanitary-sales.spec.ts',
  workers: 2,
  timeout: 30_000,
  retries: 0,
  outputDir: 'output/playwright/sanitary-sales',
  use: { baseURL, screenshot: 'only-on-failure', trace: 'retain-on-failure', serviceWorkers: 'block' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: `AUDIT_PORT=${port} node scripts/serve-audit.mjs`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'android-320', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 740 } } },
    { name: 'iphone-390', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'tablet-1024', use: { viewport: { width: 1024, height: 768 } } },
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
  ],
});
