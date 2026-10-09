import { defineConfig } from '@playwright/test';

// Build with EXPO_NO_DOTENV=1 and a placeholder backend before running.
// The audit server has no API proxy; every journey uses intercepted fixtures.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['responsive-*.spec.ts', 'app-audit.spec.ts', 'release-journeys.spec.ts', 'redesign-*.spec.ts'],
  timeout: 30000,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/responsive-results.json' }]],
  outputDir: 'output/playwright/responsive',
  use: {
    baseURL: 'http://127.0.0.1:8096',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'AUDIT_PORT=8096 node scripts/serve-audit.mjs',
    url: 'http://127.0.0.1:8096/login',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'mobile-320', use: { viewport: { width: 320, height: 740 } } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 } } },
    { name: 'tablet-portrait', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'tablet-landscape', use: { viewport: { width: 1024, height: 768 } } },
    { name: 'laptop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
});
