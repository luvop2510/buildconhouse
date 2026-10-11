import { defineConfig, devices } from '@playwright/test';

// Browser-engine and touch-device coverage supplements the six-width audit.
// All API calls are intercepted; the audit server cannot mutate production.
export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'redesign-auth-transitions.spec.ts',
    'redesign-access.spec.ts',
    'redesign-team-delegation.spec.ts',
    'responsive-furniture-rmb.spec.ts',
    'responsive-shared-floor-navigation.spec.ts',
  ],
  timeout: 30000,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/device-results.json' }]],
  outputDir: 'output/playwright/devices',
  use: {
    baseURL: 'http://127.0.0.1:8097',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'AUDIT_PORT=8097 node scripts/serve-audit.mjs',
    url: 'http://127.0.0.1:8097/login',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'android-chrome', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'iphone-safari', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'ipad-safari', use: { ...devices['iPad Pro 11'], browserName: 'webkit' } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'], browserName: 'firefox', viewport: { width: 1440, height: 900 } } },
  ],
});
