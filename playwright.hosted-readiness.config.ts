import { defineConfig } from '@playwright/test';
import audit from './playwright.audit.config';

// Fetch public hosted application files; each selected test mocks every API
// request through audit-fixtures before navigation. No local server is started.
export default defineConfig({
  ...audit,
  testDir: './e2e',
  testMatch: ['redesign-command-palette.spec.ts', 'redesign-history.spec.ts'],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 2,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'output/playwright/hosted-readiness/results.json' }],
  ],
  outputDir: './output/playwright/hosted-readiness/artifacts',
  use: {
    ...audit.use,
    baseURL: 'https://buildcon-house-nine.vercel.app',
  },
  webServer: undefined,
});
