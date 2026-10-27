import { expect, test, type Locator, type Page } from '@playwright/test';
import { captureRuntimeHealth } from './runtime-health';
import { emptySalesSummary, fourDepartmentSummary, mockSalesSummary, salesSummaryFixture } from './sales-fixtures';

async function assertWithinViewport(page: Page, controls: Locator[] = []) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page fits its viewport').toBe(true);
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(box!.height).toBeGreaterThanOrEqual(43.999);
    expect(box!.width).toBeGreaterThanOrEqual(43.999);
  }
}

async function openFilters(page: Page) {
  const toggle = page.getByTestId('sales-data-filters-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(page.getByTestId('sales-data-filters-content')).toBeVisible();
}

async function selectFloor(page: Page, label: string) {
  await openFilters(page);
  await page.getByTestId('sales-data-floor-picker').click();
  await page.getByRole('dialog', { name: 'Business unit', exact: true }).getByRole('button', { name: label, exact: true }).click();
}

async function openCustomRange(page: Page) {
  await openFilters(page);
  await page.getByTestId('sales-data-period-picker').click();
  await page.getByRole('dialog', { name: 'Reporting period', exact: true }).getByRole('button', { name: 'Custom range', exact: true }).click();
}

test('critical streamlined sales presents real product and brand evidence with three usable destinations', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await mockSalesSummary(page);
  await page.route('**/api/analytics/default-period?**', route => route.fulfill({ json: {
    preset: 'custom', date_from: '2025-01-01T00:00:00+00:00', date_to: '2025-02-01T00:00:00+00:00',
    label: 'January 2025', fallback_applied: true, latest_order_at: '2025-01-10T10:00:00+00:00',
  } }));
  const reportRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/analytics/sales-summary');
  await page.goto('/sales-data');
  expect(new URL((await reportRequest).url()).searchParams.get('preset')).toBe('this_month');
  await expect(page.getByTestId('sales-kpi-products')).toContainText('3');
  await expect(page.getByTestId('sales-brands')).toContainText('Hansgrohe');
  await expect(page.getByTestId('sales-products')).toContainText('Talis basin mixer');
  await expect(page.getByTestId('sales-products')).toContainText('Piece');
  await expect(page.getByTestId('sales-products')).toContainText('Set');
  const navigation = ['sales', 'references', 'customers'].map(name => page.getByTestId(`sales-nav-${name}`));
  await assertWithinViewport(page, navigation);
  for (const retired of ['Executive', "Today's Priorities", 'Forecasting', 'Suppliers', 'Operations']) {
    await expect(page.getByRole('link', { name: retired, exact: true })).toHaveCount(0);
  }
  await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('sales.png'), fullPage: true });
});

test('critical sales navigation works with keyboard and exposes customers follow-ups and unpaid balances', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await mockSalesSummary(page);
  await page.goto('/sales-data');
  const references = page.getByTestId('sales-nav-references');
  await references.focus();
  await expect(references).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/sales-data\/relationships(?:\?|$)/);
  await expect(page.getByRole('heading', { name: 'References', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('references.png'), fullPage: true });
  const customers = page.getByTestId('sales-nav-customers');
  await customers.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/sales-data\/customers(?:\?|$)/);
  await expect(page.getByTestId('sales-kpi-customers')).toContainText('3');
  await expect(page.getByTestId('sales-kpi-followups')).toContainText('5');
  await expect(page.getByTestId('sales-kpi-outstanding')).toContainText('60,000');
  await expect(page.getByTestId('sales-customers-list')).toContainText('Ananya Shah');
  await assertWithinViewport(page);
  await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('customers.png'), fullPage: true });
});

test('critical summary failures retry and genuine zeros retain an honest empty state', async ({ page }) => {
  let fail = true;
  await mockSalesSummary(page, { onSummary: route => fail
    ? route.fulfill({ status: 503, json: { detail: 'Sales temporarily unavailable' } })
    : route.fulfill({ json: emptySalesSummary() }) });
  await page.goto('/sales-data');
  await expect(page.getByText('Sales temporarily unavailable', { exact: true })).toBeVisible();
  await expect(page.getByTestId('sales-kpi-products')).toHaveCount(0);
  fail = false;
  await page.getByTestId('sales-summary-retry').click();
  await expect(page.getByTestId('sales-kpi-products')).toContainText('0');
  await expect(page.getByTestId('sales-brands')).toContainText(/No .*(sales|brands)/i);
  await expect(page.getByTestId('sales-products')).toContainText(/No .*(sales|products)/i);
  await expect(page.getByText('Sales temporarily unavailable', { exact: true })).toHaveCount(0);
  await assertWithinViewport(page);
});

test('critical reporting range validates dates and remains selected across tabs and reload', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  await mockSalesSummary(page, { onSummary: route => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: salesSummaryFixture });
  } });
  await page.goto('/sales-data');
  await expect(page.getByTestId('sales-kpi-products')).toBeVisible();
  await openCustomRange(page);
  await page.getByLabel('From', { exact: true }).fill('2026-02-30');
  await page.getByLabel('To', { exact: true }).fill('2026-03-01');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter valid dates');
  await page.getByLabel('From', { exact: true }).fill('2026-09-03');
  await page.getByLabel('To', { exact: true }).fill('2026-09-17');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('preset')).toBe('custom');
  expect(queries.at(-1)?.get('date_from')).toBe('2026-09-03T00:00:00+00:00');
  expect(queries.at(-1)?.get('date_to')).toBe('2026-09-18T00:00:00+00:00');
  await page.getByTestId('sales-nav-customers').click();
  await expect(page.getByTestId('sales-customers-list')).toContainText('Ananya Shah');
  expect(queries.at(-1)?.get('preset')).toBe('custom');
  await page.reload();
  await expect(page.getByTestId('sales-customers-list')).toContainText('Ananya Shah');
  expect(queries.at(-1)?.get('date_from')).toBe('2026-09-03T00:00:00+00:00');
  expect(queries.at(-1)?.get('date_to')).toBe('2026-09-18T00:00:00+00:00');
  await assertWithinViewport(page);
});

test('critical late previous-floor reads cannot relabel the selected floor', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let firstReadStarted = false;
  await mockSalesSummary(page, { onSummary: async route => {
    const floor = new URL(route.request().url()).searchParams.get('floor_id');
    if (floor === 'first-floor') {
      firstReadStarted = true;
      await held;
      return route.fulfill({ json: salesSummaryFixture }).catch(() => undefined);
    }
    const current = {
      ...salesSummaryFixture,
      brands: [{ ...salesSummaryFixture.brands[0], name: 'Current Tiles scope' }],
    };
    return route.fulfill({ json: current });
  } });
  await page.goto('/sales-data');
  await expect.poll(() => firstReadStarted).toBe(true);
  try {
    await selectFloor(page, 'Tiles');
    await expect(page.getByTestId('sales-brands')).toContainText('Current Tiles scope');
    release();
    await expect(page.getByTestId('sales-brands')).not.toContainText('Hansgrohe');
    await expect(page.getByTestId('sales-data-floor-picker')).toContainText('Tiles');
  } finally { release(); }
  await assertWithinViewport(page);
});

test('critical project departments keep financial reporting when product attribution is unavailable', async ({ page }) => {
  const summary = fourDepartmentSummary('second-floor');
  await mockSalesSummary(page, { summary, floorId: 'second-floor' });
  await page.goto('/sales-data');
  await expect(page.getByText(summary.coverage.note, { exact: true })).toBeVisible();
  await expect(page.getByTestId('sales-kpi-revenue')).toContainText('₹3,00,000.25');
  await expect(page.getByTestId('sales-kpi-orders')).toContainText('1');
  await expect(page.getByTestId('sales-kpi-products')).toHaveCount(0);
  if (page.viewportSize()!.width >= 768) {
    await expect(page.getByTestId('nav-sales-data')).toBeVisible();
    await expect(page.getByTestId('nav-sales-data')).toHaveAttribute('aria-current', 'page');
  } else {
    await page.getByRole('button', { name: 'All stages', exact: true }).click();
    const sharedReport = page.getByRole('dialog', { name: 'Kitchen stages', exact: true }).getByRole('link', { name: 'Sales Data', exact: true });
    await expect(sharedReport).toBeVisible();
    await sharedReport.click();
    await expect(page).toHaveURL(/\/sales-data(?:\?|$)/);
  }
  await page.getByTestId('sales-nav-customers').click();
  await expect(page.getByTestId('sales-kpi-outstanding')).toContainText('₹1,00,000.25');
  await expect(page.getByTestId('sales-customers-list')).toContainText('Kavya Kitchen Client');
  await assertWithinViewport(page);
});

test('critical all four departments preserve separate INR and RNB totals and customer identities', async ({ page }, info) => {
  await mockSalesSummary(page, { onSummary: route => route.fulfill({
    json: fourDepartmentSummary(new URL(route.request().url()).searchParams.get('floor_id') || 'all'),
  }) });
  await page.goto('/sales-data');
  await selectFloor(page, 'All units');
  const revenue = page.getByTestId('sales-kpi-revenue');
  await expect(revenue).toContainText('₹6,40,000.25');
  await expect(revenue).toContainText('RNB 75,000.5');
  await expect(revenue).not.toContainText('7,15,000.75');
  await expect(page.getByTestId('sales-kpi-orders')).toContainText('16');
  await expect(page.getByTestId('sales-kpi-products')).toContainText('4');
  await page.screenshot({ path: info.outputPath('all-departments-sales.png'), fullPage: true });
  await page.getByTestId('sales-nav-customers').click();
  await expect(page.getByTestId('sales-kpi-customers')).toContainText('7');
  await expect(page.getByTestId('sales-kpi-followups')).toContainText('14');
  const outstanding = page.getByTestId('sales-kpi-outstanding');
  await expect(outstanding).toContainText('₹1,85,000.25');
  await expect(outstanding).toContainText('RNB 12,500.5');
  await expect(outstanding).not.toContainText('1,97,500.75');
  const balances = page.getByTestId('sales-customers-list');
  await expect(balances).toContainText('Kavya Kitchen Client');
  await expect(balances).toContainText('Falguni Furniture Client');
  await expect(balances).toContainText('RNB 12,500.5');
  await assertWithinViewport(page);
  await page.screenshot({ path: info.outputPath('all-departments-customers.png'), fullPage: true });
});

for (const [floor, label, amount, customer, path] of [
  ['first-floor', 'Sanitary', '₹60,000', 'Ananya Shah', '/payments'],
  ['ground-floor', 'Tiles', '₹25,000', 'Aarav Joshi', '/payments'],
  ['second-floor', 'Kitchen', '₹1,00,000.25', 'Kavya Kitchen Client', '/kitchen'],
  ['third-floor', 'Furniture', 'RNB 12,500.5', 'Falguni Furniture Client', '/notebook/furniture-quotations'],
]) {
  test(`critical ${label} reporting opens its own follow-ups and account workspace`, async ({ page }) => {
    const requests: string[] = [];
    const followupFloors: string[] = [];
    page.on('request', request => {
      if (/^\/api\/followups(?:\/page)?$/.test(new URL(request.url()).pathname)) followupFloors.push(request.headers()['x-floor-id'] || '');
    });
    await mockSalesSummary(page, { onSummary: route => {
      const requestedFloor = new URL(route.request().url()).searchParams.get('floor_id') || 'all';
      requests.push(requestedFloor);
      return route.fulfill({ json: fourDepartmentSummary(requestedFloor) });
    } });
    await page.goto('/sales-data/customers');
    await selectFloor(page, label);
    await expect.poll(() => requests.at(-1)).toBe(floor);
    await expect(page.getByTestId('sales-kpi-outstanding')).toContainText(amount);
    await expect(page.getByTestId('sales-customers-list')).toContainText(customer);
    await assertWithinViewport(page);
    await page.getByTestId('sales-kpi-followups').click();
    await expect(page).toHaveURL(/\/followups(?:\?|$)/);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe(floor);
    await expect.poll(() => followupFloors.at(-1)).toBe(floor);
    await page.goto('/sales-data/customers');
    await expect(page.getByTestId('sales-customers-list')).toContainText(customer);
    await page.getByTestId('sales-kpi-outstanding').click();
    await expect(page).toHaveURL(new RegExp(`${path}(?:\\?|$)`));
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe(floor);
  });
}

test('critical all-department accounts asks for a business unit before opening its own ledger', async ({ page }) => {
  await mockSalesSummary(page, { onSummary: route => route.fulfill({
    json: fourDepartmentSummary(new URL(route.request().url()).searchParams.get('floor_id') || 'all'),
  }) });
  await page.goto('/sales-data/customers');
  await selectFloor(page, 'All units');
  await expect(page.getByTestId('sales-kpi-outstanding')).toContainText('RNB 12,500.5');
  await page.getByTestId('sales-kpi-outstanding').click();
  await page.getByRole('dialog', { name: 'Choose a business unit', exact: true }).getByRole('button', { name: 'Furniture', exact: true }).click();
  await expect(page).toHaveURL(/\/notebook\/furniture-quotations(?:\?|$)/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe('third-floor');
});

test('critical reference search keeps pre-order clients and the chosen reporting period in its detail link', async ({ page }) => {
  await mockSalesSummary(page);
  await page.route('**/api/referrers**', route => route.fulfill({ json: [{ id: 'real-reference', name: 'Nisha Shah', type: 'architect', company: 'Studio Line', shared_across_floors: true, updated_at: 'v1' }] }));
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

test('critical export sends the exact displayed brand data and reporting scope', async ({ page }) => {
  await mockSalesSummary(page);
  let posted: any;
  let floor: string | undefined;
  await page.route('**/api/exports/page.xlsx', route => {
    posted = route.request().postDataJSON();
    floor = route.request().headers()['x-floor-id'];
    return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('synthetic download') });
  });
  await page.goto('/sales-data');
  const download = page.waitForEvent('download');
  await page.getByTestId('sales-brands-export-xlsx').click();
  await download;
  expect(posted.sections[0].rows[1]).toEqual(['Hansgrohe', '180000', '2', '8', '24 Piece · 8 Set']);
  expect(floor).toBe('first-floor');
});

test('critical customer balances retain paise and select only Sales Data in the desktop sidebar', async ({ page }) => {
  const summary = {
    ...salesSummaryFixture,
    kpis: { ...salesSummaryFixture.kpis, outstanding: 60000.5 },
    customers: salesSummaryFixture.customers.map((row, i) => i ? row : { ...row, outstanding: 20000.5 }),
  };
  await mockSalesSummary(page, { summary });
  await page.goto('/sales-data/customers');
  await expect(page.getByTestId('sales-kpi-outstanding')).toContainText('60,000.5');
  await expect(page.getByTestId('sales-customers-list')).toContainText('20,000.5');
  const selected = page.locator('[aria-current="page"]');
  if (page.viewportSize()!.width >= 768) {
    await expect(selected.filter({ hasText: 'Sales Data' })).toHaveCount(1);
    await expect(selected.filter({ hasText: 'Customers' })).toHaveCount(0);
  }
});
