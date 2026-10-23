import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'redesign-font-readiness.spec.ts',
  timeout: 30_000,
  workers: 2,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/fonts-results.json' }]],
  outputDir: 'output/playwright/fonts',
  use: {
    baseURL: 'http://127.0.0.1:8191', serviceWorkers: 'block',
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: {
    command: 'AUDIT_PORT=8191 node scripts/serve-audit.mjs',
    url: 'http://127.0.0.1:8191/login', reuseExistingServer: false,
  },
  projects: [
    { name: 'android-chrome', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'iphone-safari', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'ipad-safari', use: { ...devices['iPad Pro 11'], browserName: 'webkit' } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
  ],
});
