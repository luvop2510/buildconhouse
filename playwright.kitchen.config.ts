import { defineConfig, devices } from '@playwright/test';

const origin = new URL(process.env.KITCHEN_E2E_BASE_URL || 'https://invalid.example');
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) {
  throw new Error('Run scripts/test-kitchen-e2e.mjs; Kitchen persistence acceptance requires its owned loopback API.');
}
const workflow = ['redesign-kitchen-projects.spec.ts', 'kitchen-responsive-interactions.spec.ts', 'kitchen-release-review.spec.ts', 'kitchen-note-fields.spec.ts', 'kitchen-version-workflow.spec.ts', 'kitchen-autosave.spec.ts', 'kitchen-draft-autosave.spec.ts', 'kitchen-date-defaults.spec.ts', 'kitchen-keyboard-stability.spec.ts'];
const matrix = 'kitchen-route-matrix.spec.ts';
export default defineConfig({
  testDir: './e2e', testMatch: [...workflow, matrix],
  timeout: 30000, workers: 1, retries: 0, forbidOnly: true, failOnFlakyTests: true,
  reporter: [['list'], ['json', { outputFile: process.env.KITCHEN_E2E_REPORT || 'output/playwright/kitchen-results.json' }]],
  outputDir: process.env.KITCHEN_E2E_OUTPUT || 'output/playwright/kitchen',
  use: { baseURL: origin.origin, screenshot: 'only-on-failure', trace: 'retain-on-failure', serviceWorkers: 'block' },
  projects: [
    { name: 'kitchen-desktop', testMatch: workflow, use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'kitchen-android', testMatch: workflow, use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'kitchen-phone', testMatch: workflow, use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'kitchen-ipad', testMatch: workflow, use: { ...devices['iPad Pro 11'], browserName: 'webkit' } },
    ...[
      ['narrow320', 'webkit', 320, 720], ['android360', 'chromium', 360, 800],
      ['iphone390', 'webkit', 390, 844], ['android430', 'chromium', 430, 932],
      ['tablet768', 'webkit', 768, 1024], ['tablet820', 'webkit', 820, 1180],
      ['tablet1024', 'webkit', 1024, 1366], ['desktop1440', 'chromium', 1440, 1000],
      ['desktop1920', 'chromium', 1920, 1080], ['desktop2560', 'chromium', 2560, 1440],
      ['landscape844', 'webkit', 844, 390], ['firefox1440', 'firefox', 1440, 1000],
    ].map(([name, browserName, width, height]) => ({ name: `matrix-${name}`, testMatch: matrix,
      use: { browserName: browserName as 'chromium' | 'webkit' | 'firefox', viewport: { width: Number(width), height: Number(height) } } })),
  ],
});
