import { defineConfig, devices } from '@playwright/test';

// The push gate covers every discovered page, populated-data crash regressions,
// update recovery and session navigation on real browser engines.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['app-audit.spec.ts', 'redesign-runtime-stability.spec.ts', 'redesign-followup-notes.spec.ts', 'redesign-payments.spec.ts', 'responsive-shared-floor-navigation.spec.ts', 'redesign-session-recovery.spec.ts', 'runtime-health-guard.spec.ts', 'responsive-navigation-recovery.spec.ts', 'redesign-release-recovery.spec.ts'],
  timeout: 30_000,
  workers: 2,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/stability-results.json' }]],
  outputDir: 'output/playwright/stability',
  use: {
    baseURL: 'http://127.0.0.1:8099',
    screenshot: 'only-on-failure', trace: 'retain-on-failure', serviceWorkers: 'block',
  },
  webServer: {
    command: 'node scripts/serve-stability.mjs',
    url: 'http://127.0.0.1:8099/login', reuseExistingServer: false,
  },
  projects: [
    { name: 'android-chrome', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'iphone-safari', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'ipad-safari', use: { ...devices['iPad Pro 11'], browserName: 'webkit' } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
