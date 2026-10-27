import { defineConfig } from '@playwright/test';

// The audit server never proxies to a live API. AUDIT_ROOT can select an
// immutable export while other checks continue against the working tree.
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8098';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'redesign-sales-simplification.spec.ts',
  timeout: 30000,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/sales-results.json' }]],
  outputDir: 'output/playwright/sales',
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'AUDIT_PORT=8098 node scripts/serve-audit.mjs',
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'phone-320', use: { viewport: { width: 320, height: 740 } } },
    { name: 'phone-390', use: { viewport: { width: 390, height: 844 } } },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'tablet-1024', use: { viewport: { width: 1024, height: 768 } } },
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
  ],
});
