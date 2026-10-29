import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { todayFixture, mockTodayOverview } from './today-fixtures';

for (const outcome of ['success', 'failure']) test(`critical dashboard completion is immediate and handles ${outcome}`, async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await mockSession(page, '/dashboard', false, { staff: { id: 'audit-manager', email: 'manager@example.test', full_name: 'Audit Manager', role: 'manager', active: true, floor_ids: ['first-floor'] } });
  const snapshot = todayFixture();
  const rows = snapshot.tasks;
  await mockTodayOverview(page);
  await page.route('**/api/dashboard/today', route => route.fulfill({ json: snapshot }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let mutations = 0;
  await page.route('**/api/followups/followup-0/complete', async route => {
    mutations += 1;
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    await pending;
    await route.fulfill({ status: outcome === 'success' ? 200 : 503, json: outcome === 'success' ? { ...rows[0], status: 'done' } : { detail: 'Fixture service unavailable' } });
  });
  const first = page.getByText('First fixture customer', { exact: true });
  try {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(first).toBeVisible();
    await first.hover();
    await page.getByRole('button', { name: 'Mark First fixture customer done', exact: true }).first().click();
    await expect(first).toHaveCount(0, { timeout: 750 });
    await expect(page.getByText('Saving 1 follow-up…', { exact: true })).toBeVisible();
    await expect(page.getByText('Second fixture customer', { exact: true })).toBeVisible();
    expect(mutations).toBe(1);
    release();
    await expect(page.getByText('Saving 1 follow-up…', { exact: true })).toHaveCount(0);
    if (outcome === 'failure') {
      await expect(first).toBeVisible();
      await expect(page.getByText('Could not confirm completion. Follow-up restored; refresh to check or try again.', { exact: true })).toBeVisible();
    } else {
      await expect(first).toHaveCount(0);
      await expect(page.getByText('First fixture customer — marked done', { exact: true })).toBeVisible();
    }
  } finally { release(); }
});
