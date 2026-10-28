import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const outcome of ['success', 'failure']) test(`critical dashboard completion is immediate and handles ${outcome}`, async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await mockSession(page, '/dashboard');
  const rows = ['First', 'Second'].map((name, i) => ({ id: `followup-${i}`, customer_name: `${name} fixture customer`, status: 'open', reason: 'Call about quotation', priority_level: 'high' }));
  await page.route('**/api/followups?**', route => route.fulfill({ json: rows }));
  await page.route('**/api/followups/mission', route => route.fulfill({ json: { due_count: 2, revenue_at_risk_short: '1000', estimated_minutes: 2, greeting_name: 'Fixture' } }));
  await page.route('**/api/dashboard/stats', route => route.fulfill({ json: { open_pipeline: 1000, revenue_month: 500, quotes_this_month: 1, pending_approval: 0 } }));
  await page.route('**/api/payments/stats', route => route.fulfill({ json: { total_outstanding: 0, collected_this_month: 0, active_orders: 0 } }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchases/shortages?**', route => route.fulfill({ json: { items: [] } }));
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
    await page.getByRole('button', { name: 'Mark done', exact: true }).first().click();
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
