import { defineConfig, devices } from '@playwright/test';
const baseURL = `http://127.0.0.1:${process.env.FORGE_STABILITY_PORT || '8099'}`;

// The push gate covers every discovered page, populated-data crash regressions,
// update recovery and session navigation on real browser engines.
export default defineConfig({
  testDir: './e2e',
  // Transfer timeout recovery is a required populated stock workflow.
  testMatch: ['redesign-sales-simplification.spec.ts', 'redesign-sales-reference-directory.spec.ts', 'redesign-interior-acquisition.spec.ts', 'redesign-tile-mobile-orders.spec.ts', 'redesign-tile-mobile-details.spec.ts', 'redesign-kitchen-visit-recovery.spec.ts', 'redesign-followup-menu-overflow.spec.ts', 'redesign-input-focus-shape.spec.ts', 'redesign-kitchen-request-recovery.spec.ts', 'redesign-keyboard-scroll.spec.ts', 'redesign-keyboard-no-gaps.spec.ts', 'redesign-keyboard-viewport.spec.ts', 'redesign-tile-purchase-images.spec.ts', 'redesign-sanitary-sales.spec.ts', 'redesign-godown-transfer-retry.spec.ts', 'redesign-backend-startup.spec.ts', 'redesign-quotation-workspace.spec.ts', 'redesign-font-readiness.spec.ts', 'redesign-mobile-startup.spec.ts', 'redesign-mobile-workspace.spec.ts', 'redesign-mobile-filters.spec.ts', 'redesign-mobile-payments.spec.ts', 'redesign-mobile-summary.spec.ts', 'app-audit.spec.ts', 'redesign-runtime-stability.spec.ts', 'redesign-followup-notes.spec.ts', 'redesign-sanitary-followups.spec.ts', 'redesign-payments.spec.ts', 'responsive-shared-floor-navigation.spec.ts', 'responsive-customer-quotation.spec.ts', 'redesign-session-recovery.spec.ts', 'runtime-health-guard.spec.ts', 'responsive-navigation-recovery.spec.ts', 'redesign-release-recovery.spec.ts'],
  timeout: 30_000,
  workers: 2,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/stability-results.json' }]],
  outputDir: 'output/playwright/stability',
  use: {
    baseURL,
    screenshot: 'only-on-failure', trace: 'retain-on-failure', serviceWorkers: 'block',
  },
  webServer: {
    command: 'node scripts/serve-stability.mjs',
    url: `${baseURL}/login`, reuseExistingServer: false,
  },
  projects: [
    { name: 'android-chrome', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'iphone-safari', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'ipad-safari', use: { ...devices['iPad Pro 11'], browserName: 'webkit' } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
