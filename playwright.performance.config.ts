import { defineConfig, devices } from '@playwright/test';

// Serve the release export without any API proxy. The performance fixtures
// model API latency; no account, business data or external host is contacted.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'performance-startup.spec.ts',
  timeout: 30_000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: process.env.PERFORMANCE_REPORT || 'output/playwright/performance-results.json' }]],
  outputDir: 'output/playwright/performance',
  use: {
    baseURL: 'http://127.0.0.1:8098',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'AUDIT_PORT=8098 node scripts/serve-audit.mjs',
    url: 'http://127.0.0.1:8098/login',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'android-chrome', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'iphone-safari', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'ipad-safari', use: { ...devices['iPad Pro 11'], browserName: 'webkit' } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
