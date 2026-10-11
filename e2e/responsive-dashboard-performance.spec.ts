import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:8096'
    ? route.continue() : route.abort());
});

test('dashboard publishes ready sections while an unrelated request is pending', async ({ page }) => {
  await mockSession(page, '/dashboard');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let delayedRequestStarted = false;
  await page.route('**/api/purchases/shortages?**', async route => {
    delayedRequestStarted = true;
    await pending;
    await route.fulfill({ json: { items: [] } });
  });
  await page.route('**/api/followups?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/mission', route => route.fulfill({ json: {
    due_count: 0, revenue_at_risk_short: '0', estimated_minutes: 0,
    greeting_name: 'Ready sections', overdue_payments: 0,
  } }));
  await page.route('**/api/dashboard/stats', route => route.fulfill({ json: {
    open_pipeline: 1000, revenue_month: 500, quotes_this_month: 1, pending_approval: 0,
  } }));
  await page.route('**/api/payments/stats', route => route.fulfill({ json: {
    total_outstanding: 0, collected_this_month: 500, active_orders: 1,
  } }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  try {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => delayedRequestStarted).toBe(true);
    // The server still hasn't completed purchases: these assertions fail
    // with the former single Promise.allSettled publication barrier.
    await expect(page.getByText('All clear. No follow-ups waiting.', { exact: true })).toBeVisible();
    await expect(page.getByText('No quotations yet.', { exact: true })).toBeVisible();
    await expect(page.getByText(/Ready sections\./)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { release(); }
});

test('legacy brand page redirects to current analytics preserving reporting context', async ({ page }) => {
  await mockSession(page, '/sales-data/brand/fixture-brand');
  await page.goto('/sales-data/brand/fixture-brand?preset=year&floorId=ground-floor');
  await expect(page).toHaveURL(/\/sales-data\/brands\/fixture-brand\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('preset')).toBe('year');
  expect(url.searchParams.get('floorId')).toBe('ground-floor');
});

test('dashboard-only grants do not fetch or link unrelated pages', async ({ page }) => {
  const grant = { resource: 'dashboard', floor_id: 'first-floor', actions: ['view'] };
  await mockSession(page, '/dashboard', false, {
    staff: { id: 'limited-staff', email: 'limited@example.test', full_name: 'Limited Staff',
      role: 'worker', custom_access: true, active: true, floor_ids: ['first-floor'], access_grants: [grant] },
    grants: [grant],
  });
  const forbidden: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(followups|payments|quotations|purchases)(?:\/|$)/.test(path)) forbidden.push(path);
  });
  await page.route('**/api/dashboard/stats', route => route.fulfill({ json: {
    open_pipeline: 1000, revenue_month: 500, quotes_this_month: 1, pending_approval: 3,
  } }));
  await page.goto('/dashboard');
  await expect(page.getByText('1 quotations this month', { exact: true })).toBeVisible();
  await expect(page.getByText('Some information is unavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /quotation.*waiting for approval/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View all quotations' })).toHaveCount(0);
  await expect(page.getByText('Collected this month', { exact: true })).toHaveCount(0);
  expect(forbidden).toEqual([]);
});
