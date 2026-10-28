import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8103';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'sales-analytics.spec.ts',
  timeout: 30_000,
  workers: 2,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/analytics-results.json' }]],
  outputDir: 'output/playwright/analytics',
  use: { baseURL, browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure', serviceWorkers: 'block' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'AUDIT_PORT=8103 node scripts/serve-audit.mjs',
    url: `${baseURL}/login`,
    reuseExistingServer: false,
  },
  projects: [320, 375, 768, 1024, 1440].map(width => ({ name: `width-${width}`, use: { viewport: { width, height: width < 768 ? 844 : 960 } } })),
});
