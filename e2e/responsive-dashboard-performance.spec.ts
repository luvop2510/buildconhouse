import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { todayFixture, mockTodayOverview } from './today-fixtures';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:8096'
    ? route.continue() : route.abort());
});

test('Today loads floor work without requesting company analytics or unrelated pages', async ({ page }) => {
  await mockSession(page, '/dashboard', false);
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname); });
  await mockTodayOverview(page);
  await page.route('**/api/dashboard/today', route => route.fulfill({ json: todayFixture() }));
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('First fixture customer', { exact: true })).toBeVisible();
  await expect(page.getByText('Floor payments', { exact: true })).toBeVisible();
  expect(requests.filter(path => /sales-analytics|dashboard\/stats|followups\/mission|payments\/stats|purchases\/shortages/.test(path))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
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
  const data = todayFixture('first-floor', false);
  data.resources = [];
  data.tasks = [];
  data.task_summary = {open:0,overdue:0,due_today:0,completed_today:0};
  await mockTodayOverview(page);
  await page.route('**/api/dashboard/today', route => route.fulfill({ json: data }));
  await page.goto('/dashboard');
  await expect(page.getByText('No open tasks recorded.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('today-floor-overview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Open quotations|Open payments/ })).toHaveCount(0);
  expect(forbidden).toEqual([]);
});
