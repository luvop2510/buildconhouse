import { referrerCode } from '../src/utils/referrer';
import { expect, test } from '@playwright/test';
import { captureRuntimeHealth } from './runtime-health';
import { mockSalesSummary } from './sales-fixtures';
import { analyticsDashboard, mockSalesAnalytics } from './sales-analytics-fixtures';
import { analyticsChoice, analyticsCustomRange, analyticsExplore, analyticsExport, analyticsFitsViewport, analyticsFloor } from './sales-analytics-helpers';

// The complete analytics specification supersedes the former three-view layout.
// These release regressions retain the original financial, scope and recovery checks.
test('critical analytics presents confirmed sales and every shared entity destination', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await mockSalesAnalytics(page);
  await page.goto('/sales-data');
  await expect(page.getByTestId('analytics-kpi-orders')).toContainText('3');
  await expect(page.getByTestId('analytics-sales-hero')).toContainText('Confirmed sales');
  await expect(page.getByTestId('analytics-order-activity')).toBeVisible();
  await analyticsExplore(page,'companies');
  await expect(page.getByTestId('analytics-entity-company-a')).toContainText('Hansgrohe');
  await analyticsExplore(page,'products');
  await expect(page.getByTestId('analytics-entity-product-a')).toContainText('Talis basin mixer');
  await page.getByTestId('analytics-nav-dashboard').click();
  await expect(page.getByTestId('analytics-kpi-orders')).toContainText('3');
  await analyticsFitsViewport(page, [page.getByTestId('analytics-nav-dashboard'), page.getByTestId('analytics-navigation-open')]);
  await page.getByTestId('analytics-navigation-open').click();
  await analyticsFitsViewport(page, ['companies','products','architects','customers','reports'].map(name => page.getByTestId(`analytics-nav-${name}`)));
  await page.keyboard.press('Escape');
  await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('sales-analytics.png'), fullPage: true });
});

test('critical analytics destinations work with keyboard and open shared customer profiles', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data');
  await analyticsExplore(page, 'customers', true);
  await expect(page).toHaveURL(/\/sales-data\/customers(?:\?|$)/);
  await page.getByTestId('analytics-entity-customer-a').click();
  await expect(page).toHaveURL(/\/profile\/customers\/customer-a(?:\?|$)/);
  await expect(page.getByRole('heading', { name: 'Ananya Shah', exact: true })).toBeVisible();
  await analyticsFitsViewport(page);
});

test('critical summary failures retry and genuine zeros retain an honest empty state', async ({ page }) => {
  let fail = true;
  const empty = analyticsDashboard('second-floor');
  await mockSalesAnalytics(page, { dashboard: route => fail
    ? route.fulfill({ status: 503, json: { detail: 'Sales temporarily unavailable' } })
    : route.fulfill({ json: empty }) });
  await page.goto('/sales-data');
  await expect(page.getByRole('alert')).toContainText('Sales temporarily unavailable');
  await expect(page.getByTestId('analytics-kpi-orders')).toHaveCount(0);
  fail = false;
  await page.getByTestId('analytics-retry').click();
  await expect(page.getByTestId('analytics-kpi-orders')).toContainText('0');
  await expect(page.getByTestId('analytics-empty').first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await analyticsFitsViewport(page);
});

test('critical reporting range validates dates and remains selected across tabs and reload', async ({ page }) => {
  const requests: URL[] = [];
  await mockSalesAnalytics(page, { onRequest: url => requests.push(url) });
  await page.goto('/sales-data');
  await expect(page.getByTestId('analytics-kpi-orders')).toBeVisible();
  await analyticsCustomRange(page, '2026-09-17', '2026-09-03');
  await page.getByTestId('analytics-filter-apply').click();
  await expect(page.getByRole('alert')).toContainText(/valid|after/i);
  await page.getByTestId('analytics-date-from').fill('2026-09-03');
  await page.getByTestId('analytics-date-to').fill('2026-09-17');
  await analyticsChoice(page, 'analytics-date-basis', 'payment');
  await page.getByTestId('analytics-filter-apply').click();
  await expect.poll(() => requests.filter(url => url.pathname.endsWith('/dashboard')).at(-1)?.searchParams.get('date_basis')).toBe('payment');
  await analyticsExplore(page, 'customers');
  await expect(page.getByTestId('analytics-entity-customer-a')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('analytics-entity-customer-a')).toBeVisible();
  for (const [key, value] of [['preset','custom'],['date_from','2026-09-03'],['date_to','2026-09-17'],['date_basis','payment']]) {
    expect(new URL(page.url()).searchParams.get(key)).toBe(value);
    expect(requests.at(-1)?.searchParams.get(key)).toBe(value);
  }
  await analyticsFitsViewport(page);
});

test('critical late previous-floor reads cannot relabel the selected floor', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let firstReadStarted = false;
  await mockSalesAnalytics(page, { dashboard: async route => {
    const floor = new URL(route.request().url()).searchParams.get('floor_id') || 'all';
    if (floor === 'first-floor') { firstReadStarted = true; await held; }
    return route.fulfill({ json: analyticsDashboard(floor) }).catch(() => undefined);
  } });
  await page.goto('/sales-data?floor_id=first-floor');
  await expect.poll(() => firstReadStarted).toBe(true);
  try {
    await analyticsFloor(page, 'ground-floor');
    await expect(page.getByTestId('analytics-kpi-sales')).toContainText('60,000.5');
    release();
    await expect(page.getByTestId('analytics-kpi-sales')).not.toContainText('2,40,000');
    expect(new URL(page.url()).searchParams.get('floor_id')).toBe('ground-floor');
  } finally { release(); }
  await analyticsFitsViewport(page);
});

test('critical project departments identify unavailable product attribution without inventing zero', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data/floor/second-floor?floor_id=second-floor');
  await expect(page.getByText('Product attribution unavailable for this workflow.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹0');
  await expect(page.getByTestId('analytics-kpi-aov')).toContainText('Unavailable');
  await expect(page.getByTestId('analytics-entity-product-a')).toHaveCount(0);
  await analyticsFitsViewport(page);
});

test('critical all four departments preserve separate INR and RNB totals and customer identities', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data?floor_id=all');
  const sales = page.getByTestId('analytics-kpi-sales');
  await expect(sales).toContainText('₹3,00,000.5');
  await expect(sales).not.toContainText('RNB');
  await expect(page.getByTestId('analytics-furniture')).toContainText('RNB 75,000.5');
  await expect(sales).not.toContainText('3,75,001');
  await expect(page.getByTestId('analytics-kpi-orders')).toContainText('3');
  await analyticsExplore(page, 'customers');
  await expect(page.getByTestId('analytics-entity-customer-a')).toContainText('Ananya Shah');
  await expect(page.getByTestId('analytics-entity-customer-c')).toContainText('Falguni Furniture Client');
  await expect(page.getByTestId('analytics-entity-customer-c')).not.toContainText('RNB');
  await analyticsFloor(page, 'third-floor');
  await expect(page.getByTestId('analytics-entity-customer-c')).toContainText('RNB 75,000.5');
  await analyticsFitsViewport(page);
});

for (const [floor, label, amount] of [
  ['first-floor','Sanitary','₹2,40,000'], ['ground-floor','Tiles','₹60,000.5'],
  ['second-floor','Kitchen','₹0'], ['third-floor','Furniture','RNB 75,000.5'],
]) test(`critical ${label} dashboard drills to its own confirmed source records`, async ({ page }) => {
  const requests: URL[] = [];
  await mockSalesAnalytics(page, { onRequest: url => requests.push(url) });
  await page.goto(`/sales-data/floor/${floor}?floor_id=${floor}&date_basis=confirmation`);
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText(amount);
  await page.getByTestId('analytics-kpi-orders').click();
  await expect(page).toHaveURL(/\/sales-data\/records\?/);
  await expect.poll(() => requests.filter(url => url.pathname.endsWith('/records')).at(-1)?.searchParams.get('floor_id')).toBe(floor);
  expect(new URL(page.url()).searchParams.get('metric')).toBe('orders');
  await analyticsFitsViewport(page);
});

test('critical floor and trend chart drills preserve the selected date basis and source dimension', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data?floor_id=all&date_basis=payment');
  await page.getByTestId('analytics-point-2026-10-10').click();
  await expect(page).toHaveURL(/\/sales-data\/records\?/);
  const query = new URL(page.url()).searchParams;
  expect(query.get('date_basis')).toBe('payment');
  expect(query.get('preset')).toBe('custom');
  expect(query.get('dimension')).toBe('2026-10-10');
  expect(query.get('date_from')).toBe('2026-10-10T06:00:00Z');
  expect(query.get('date_to')).toBe('2026-10-11T06:00:00Z');
  await analyticsFitsViewport(page);
});

test('critical reference search keeps pre-order clients and the chosen reporting period in its detail link', async ({ page }) => {
  await mockSalesSummary(page);
  await page.route('**/api/referrers/page?**', route => {
    const search = new URL(route.request().url()).searchParams.get('search')?.toLowerCase() || '';
    const rows = [{ id: 'real-reference', name: 'Nisha Shah', type: 'architect', company: 'Studio Line', shared_across_floors: true, updated_at: 'v1' }]
      .filter(row => [row.name, row.company, referrerCode(row.id, row.type, row.name)].some(value => value.toLowerCase().includes(search)));
    return route.fulfill({ json: { rows, total: rows.length, offset: 0, limit: 25 } });
  });
  await page.route('**/api/analytics/workspaces/relationships?**', route => route.fulfill({ json: {
    workspace: 'relationships', period: 'This month', kpis: { revenue: 0, orders: 0, outstanding: 0 }, brands: [], products: [], customers: [], floors: [],
    relationships: [{ id: 'real-reference', name: 'Nisha Shah', company: 'Studio Line', type: 'architect', customers: 0, customers_acquired: 7, revenue: 0, orders: 0, last_order_at: null }],
  } }));
  await page.goto('/sales-data/relationships');
  const row = page.getByTestId('reference-row-real-reference');
  await expect(row).toContainText('Nisha Shah');
  await expect(row).toContainText('7');
  const link = row.getByRole('link');
  await expect(link).toHaveAttribute('href', /preset=this_month/);
  await page.getByTestId('references-search').fill('no match');
  await expect(page.getByText(/No matching references/)).toBeVisible();
  await page.getByTestId('references-search').fill('Studio Line');
  await expect(row).toBeVisible();
});

test('critical selected profile export preserves entity identity and the exact reporting scope', async ({ page }) => {
  let exported: URL | undefined;
  await mockSalesAnalytics(page, { onRequest: url => { if (url.pathname.endsWith('/export')) exported = url; } });
  await page.goto('/sales-data/profile/companies/company-a?floor_id=first-floor&preset=custom&date_from=2026-09-03&date_to=2026-09-17&date_basis=confirmation');
  await expect(page.getByRole('heading', { name: 'Hansgrohe', exact: true })).toBeVisible();
  const download = await analyticsExport(page, 'xlsx');
  expect(download.suggestedFilename()).toContain('company-a');
  for (const [key, value] of [['view','profile'],['kind','companies'],['entity_id','company-a'],['floor_id','first-floor'],['preset','custom'],['date_from','2026-09-03'],['date_to','2026-09-17'],['date_basis','confirmation'],['format','xlsx']]) expect(exported?.searchParams.get(key)).toBe(value);
});

test('critical order balances retain paise and Sales Data stays selected in the desktop sidebar', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data/order/order-b?floor_id=ground-floor');
  await expect(page.getByText(/20,000.5/).first()).toBeVisible();
  if (page.viewportSize()!.width >= 768) {
    const selected = page.locator('[aria-current="page"]');
    await expect(selected.filter({ hasText: 'Sales Data' })).toHaveCount(1);
    await expect(selected.filter({ hasText: 'Customers' })).toHaveCount(0);
  }
  await analyticsFitsViewport(page);
});
