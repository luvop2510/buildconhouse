import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'responsive-table-layout.spec.ts', timeout: 30000,
  workers: 2, retries: 0, forbidOnly: true, failOnFlakyTests: true,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/table-results.json' }]],
  outputDir: 'output/playwright/table-layout',
  use: { baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8090', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: 'node scripts/serve-audit.mjs', url: 'http://127.0.0.1:8090/login', reuseExistingServer: !process.env.CI },
  projects: [
    ...[320, 390, 768, 834, 1024, 1440, 1920].map(width => ({ name: `chromium-${width}`, use: { browserName: 'chromium' as const, viewport: { width, height: width === 1024 ? 768 : 1000 } } })),
    { name: 'webkit-390', use: { browserName: 'webkit', viewport: { width: 390, height: 844 } } },
    { name: 'webkit-834', use: { browserName: 'webkit', viewport: { width: 834, height: 1112 } } },
  ],
});
