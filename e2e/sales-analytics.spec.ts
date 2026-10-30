import { expect, test } from '@playwright/test';
import { analyticsDashboard, mockSalesAnalytics } from './sales-analytics-fixtures';
import { analyticsExplore, analyticsExport, analyticsFitsViewport, analyticsFloor } from './sales-analytics-helpers';
import { captureRuntimeHealth } from './runtime-health';

test('overall dashboard charts and all floor destinations fit compact and regular widths', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await mockSalesAnalytics(page);
  await page.goto('/sales-data?date_basis=confirmation&preset=this_month');
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹3,00,000.5');
  await expect(page.getByTestId('analytics-trend')).toBeVisible();
  for (const card of ['revenue', 'comparison', 'treemap', 'seasonality']) {
    await expect(page.getByTestId(`analytics-bento-${card}`)).toBeVisible();
  }
  const viewport = page.viewportSize()!;
  const kpis = await page.getByTestId('analytics-kpis').boundingBox();
  expect(kpis!.height, 'Sales metrics remain a compact group').toBeLessThan(viewport.width < 360 ? 320 : 240);
  const plot = page.getByTestId('analytics-trend').locator('svg').first();
  await expect(plot).toBeVisible();
  expect((await plot.boundingBox())!.height, 'The primary plot leaves room for comparison content').toBeLessThanOrEqual(viewport.width < 768 ? 160 : 192);
  await expect(page.getByTestId('analytics-collection-balance')).toBeVisible();
  for (const floor of ['ground-floor', 'first-floor', 'second-floor', 'third-floor']) {
    await expect(page.getByTestId(`analytics-floor-${floor}`)).toBeVisible();
  }
  await analyticsFitsViewport(page, [page.getByTestId('analytics-filter-open'), page.getByTestId('analytics-export')]);
  expect(await page.getByTestId('analytics-kpi-sales').evaluate(root => {
    const text = Array.from(root.querySelectorAll('*')).find(node => node.childElementCount === 0 && node.textContent === '₹3,00,000.5');
    if (!text) return false;
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getClientRects().length === 1;
  }), 'Exact currency amount keeps its decimal on the same line').toBe(true);
  expect(await page.getByTestId('analytics-kpi-aov').evaluate(root => { const text=Array.from(root.querySelectorAll('*')).find(node=>node.childElementCount===0&&node.textContent==='₹1,50,000.25'); if(!text)return false; const range=document.createRange(); range.selectNodeContents(text); return range.getClientRects().length===1; }), 'Average order amount stays on one line').toBe(true);
  await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('analytics-responsive.png'), fullPage: true });
  const trend = page.getByTestId('analytics-trend');
  await trend.scrollIntoViewIfNeeded();
  await trend.screenshot({ path: info.outputPath('analytics-trend.png') });
  await page.getByTestId('analytics-floor-first-floor').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('analytics-contribution.png'), fullPage: true });
});

test('source orders open complete details with lines payments history and export', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data/records?floor_id=first-floor&company_id=company-a&date_basis=confirmation');
  await page.getByTestId('analytics-record-order-a').click();
  await expect(page).toHaveURL(/\/sales-data\/order\/order-a\?/);
  expect(new URL(page.url()).searchParams.get('company_id')).toBe('company-a');
  await expect(page.getByText('Talis basin mixer', { exact: true })).toBeVisible();
  await expect(page.getByText(/60,000/).first()).toBeVisible();
  await expect(page.getByText(/Supporting documents unavailable/)).toBeVisible();
  const download = await analyticsExport(page, 'pdf');
  expect(download.suggestedFilename()).toContain('order-a');
  await analyticsFitsViewport(page);
});

test('product profile has scoped PDF and Excel exports with preserved source filters', async ({ page }) => {
  const exported: URL[] = [];
  await mockSalesAnalytics(page, { onRequest: url => { if (url.pathname.endsWith('/export')) exported.push(url); } });
  await page.goto('/sales-data/profile/products/product-a?floor_id=first-floor&company_id=company-a&date_basis=delivery&search=Talis&sort=sales');
  await expect(page.getByRole('heading', { name: 'Talis basin mixer', exact: true })).toBeVisible();
  for (const format of ['pdf', 'xlsx'] as const) {
    await analyticsExport(page, format);
    const query = exported.at(-1)!.searchParams;
    for (const [key, value] of [['format', format], ['entity_id', 'product-a'], ['kind', 'products'], ['floor_id', 'first-floor'], ['company_id', 'company-a'], ['date_basis', 'delivery'], ['search', 'Talis'], ['sort', 'sales']]) expect(query.get(key)).toBe(value);
  }
  await analyticsFitsViewport(page);
});

test('forbidden direct profile and export requests show recovery without protected rows', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.route('**/api/sales-analytics/entities/customers/customer-a?**', route => route.fulfill({ status: 403, json: { detail: 'This customer is outside your accessible business units.' } }));
  await page.goto('/sales-data/profile/customers/customer-a?floor_id=first-floor');
  await expect(page.getByRole('alert')).toContainText('outside your accessible business units');
  await expect(page.getByTestId('analytics-record-order-a')).toHaveCount(0);
  await expect(page.getByTestId('analytics-retry')).toBeVisible();
  await expect(page.getByTestId('analytics-export')).toHaveCount(0);
  await page.goto('/sales-data/profile/products/product-a?floor_id=first-floor');
  await expect(page.getByRole('heading', { name: 'Talis basin mixer', exact: true })).toBeVisible();
  await page.route('**/api/sales-analytics/export?**', route => route.fulfill({ status: 403, json: { detail: 'You do not have permission to export these records.' } }));
  await page.getByTestId('analytics-export').click();
  await page.getByTestId('analytics-export-pdf').click();
  await expect(page.getByRole('alert').last()).toContainText('permission to export');
  await analyticsFitsViewport(page);
});

test('owner sales overview retains independently scoped team effort', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  const requests: URL[] = [];
  await mockSalesAnalytics(page, { onRequest: url => requests.push(url) });
  await page.goto('/sales-data?preset=custom&date_from=2026-09-01&date_to=2026-09-30');
  await expect(page.getByRole('heading', { name: 'Company overview', exact: true })).toBeVisible();
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹3,00,000.5');
  const operations = page.getByTestId('analytics-owner-operations');
  await expect(operations.getByTestId('analytics-team-graphic')).toBeVisible();
  await expect(operations).toContainText('Mira Patel');
  await operations.getByRole('button', { name: 'View team details', exact: true }).click();
  await expect(operations).toContainText('3 contacts');
  await expect(operations).toContainText('last 30 days');
  await expect(operations).toContainText('recorded completed');
  await expect(operations.getByTestId('analytics-workflow-second-floor')).toContainText('7 projects · 4 active · 2 completed · 1 overdue');
  await operations.getByRole('button',{name:'View workflow stages',exact:true}).click();
  await expect(operations.getByText('Production',{exact:true})).toBeVisible();
  expect(requests.filter(url => url.pathname.endsWith('/owner-operations')).at(-1)?.searchParams.has('date_from')).toBe(false);
  await expect(page.getByText('Won this month', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('analytics-kpis')).toHaveCount(1);
  await analyticsFloor(page, 'ground-floor');
  await expect(operations).toContainText('Arjun Shah');
  await expect(operations).not.toContainText('Mira Patel');
  await expect(page.getByTestId('analytics-page')).not.toContainText('RNB');
  expect(requests.filter(url => url.pathname.endsWith('/owner-operations')).at(-1)?.searchParams.get('floor_id')).toBe('ground-floor');
  await analyticsFitsViewport(page);
  await health.assertHealthy();
});

test('owner team read failure leaves sales usable and has an explicit recovery', async ({ page }) => {
  let fail = true;
  await mockSalesAnalytics(page, { operations: route => fail
    ? route.fulfill({ status: 503, json: { detail: 'Team activity temporarily unavailable' } })
    : route.fulfill({ json: { generated_at: '2026-10-29T06:30:00Z', floor_ids: ['first-floor'], period_label: 'Current follow-ups · contacts in the last 30 days', open_followups: 0, overdue_followups: 0, completed_followups: 0, dismissed_followups: 0, unassigned_followups: 0, team: [], notes: [] } }) });
  await page.goto('/sales-data?floor_id=first-floor');
  const operations = page.getByTestId('analytics-owner-operations');
  await expect(operations.getByRole('alert')).toContainText('Team activity temporarily unavailable');
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹2,40,000');
  fail = false;
  await operations.getByTestId('analytics-retry').click();
  await expect(operations).toContainText('No assigned follow-ups');
  await expect(operations.getByRole('alert')).toHaveCount(0);
  await analyticsFitsViewport(page);
});

test('report preview and device history preserve the selected filter state', async ({ page }) => {
  let exportQuery: URLSearchParams | undefined;
  await mockSalesAnalytics(page, { onRequest: url => { if (url.pathname.endsWith('/export')) exportQuery = url.searchParams; } });
  await page.goto('/sales-data/reports?floor_id=first-floor&date_basis=payment&preset=custom&date_from=2026-10-01&date_to=2026-10-28');
  await page.getByTestId('analytics-report-title').fill('October sanitary collections review');
  await page.getByTestId('analytics-report-preview').click();
  await expect(page.getByRole('heading', { name: 'October sanitary collections review', exact: true })).toBeVisible();
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹1,80,000');
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('Collected amount');
  await page.reload();
  const saved = page.getByRole('link', { name: 'October sanitary collections review. Open details', exact: true });
  await expect(saved).toBeVisible();
  await saved.click();
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹1,80,000');
  const query = new URL(page.url()).searchParams;
  expect(query.get('floor_id')).toBe('first-floor');
  expect(query.get('date_basis')).toBe('payment');
  expect(query.get('date_from')).toBe('2026-10-01');
  expect(query.get('date_to')).toBe('2026-10-28');
  await analyticsExport(page, 'pdf');
  expect(exportQuery?.get('report_title')).toBe('October sanitary collections review');
  expect(exportQuery?.get('date_basis')).toBe('payment');
  expect(exportQuery?.get('floor_id')).toBe('first-floor');
  await analyticsFitsViewport(page);
});

test('entity analysis tab export and browser Back retain profile and source context', async ({ page }) => {
  const requests: URL[] = [];
  await mockSalesAnalytics(page, { onRequest: url => requests.push(url) });
  await page.goto('/sales-data/profile/companies/company-a?floor_id=first-floor&date_basis=confirmation&preset=custom&date_from=2026-10-01&date_to=2026-10-28&sort=date_desc');
  await page.getByTestId('analytics-profile-tab-orders').click();
  await expect(page.getByTestId('analytics-row-order-a')).toBeVisible();
  await page.getByTestId('analytics-export').click();
  await page.getByTestId('analytics-export-scope').click();
  await page.getByTestId('analytics-export-scope-current').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('analytics-export-xlsx').click();
  await download;
  const query = requests.filter(url => url.pathname.endsWith('/export')).at(-1)!.searchParams;
  expect(query.get('scope')).toBe('current');
  expect(query.get('tab')).toBe('orders');
  expect(query.get('entity_id')).toBe('company-a');
  await page.getByTestId('analytics-row-order-a').click();
  await expect(page).toHaveURL(/\/sales-data\/order\/order-a\?/);
  expect(new URL(page.url()).searchParams.get('company_id')).toBe('company-a');
  await page.goBack();
  await expect(page.getByTestId('analytics-row-order-a')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('tab')).toBe('orders');
  expect(new URL(page.url()).searchParams.get('sort')).toBe('date_desc');
  await analyticsFitsViewport(page);
});

test('keyboard navigation carries edited filters between analytics destinations', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data?floor_id=first-floor&preset=this_month&date_basis=confirmation');
  await expect(page.getByTestId('analytics-kpi-orders')).toBeVisible();
  await page.getByTestId('analytics-filter-open').click();
  await page.getByTestId('analytics-period').click();
  await page.getByTestId('analytics-period-custom').click();
  await page.getByTestId('analytics-date-from').fill('2026-10-01');
  await page.getByTestId('analytics-date-to').fill('2026-10-28');
  await page.getByTestId('analytics-date-basis').click();
  await page.getByTestId('analytics-date-basis-payment').click();
  await page.getByTestId('analytics-filter-apply').click();
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹1,80,000');
  await analyticsExplore(page, 'customers', true);
  await expect(page).toHaveURL(/\/sales-data\/customers\?/);
  for (const [key, value] of [['floor_id', 'first-floor'], ['preset', 'custom'], ['date_basis', 'payment'], ['date_from', '2026-10-01'], ['date_to', '2026-10-28']]) expect(new URL(page.url()).searchParams.get(key)).toBe(value);
  await page.reload();
  await expect(page.getByTestId('analytics-entity-customer-a')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('preset')).toBe('custom');
  await analyticsFitsViewport(page);
});

test('owner reviews duplicate stable identities with an explicit note and no automatic merge', async ({ page }) => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await mockSalesAnalytics(page);
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/sales-analytics/')) writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await page.goto('/sales-data/data-quality?floor_id=first-floor&kind=customers');
  const group = page.getByTestId('analytics-duplicate-duplicate-customers');
  await expect(group).toContainText('customer-a');
  await expect(group).toContainText('customer-review-b');
  await page.getByTestId('analytics-duplicate-save-duplicate-customers').click();
  await expect(page.getByRole('alert')).toContainText('Add a review note');
  expect(writes).toHaveLength(0);
  await page.getByTestId('analytics-duplicate-decision-duplicate-customers').click();
  await page.getByTestId('analytics-duplicate-decision-duplicate-customers-distinct').click();
  await page.getByTestId('analytics-duplicate-note-duplicate-customers').fill('Compared source records; these are distinct customer identities.');
  await page.getByTestId('analytics-duplicate-save-duplicate-customers').click();
  await expect(group).toContainText('Revision 1');
  expect(writes).toEqual([{ path: '/api/sales-analytics/duplicates/review', body: { kind: 'customers', entity_ids: ['customer-a', 'customer-review-b'], decision: 'distinct', note: 'Compared source records; these are distinct customer identities.', expected_revision: 0 } }]);
  await expect(group).toContainText('customer-a');
  await expect(group).toContainText('customer-review-b');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(group).toContainText('Reviewed — distinct identities');
  await analyticsFitsViewport(page);
});

test('duplicate review conflicts retain the entered note for explicit recovery', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.route('**/api/sales-analytics/duplicates/review?**', route => route.fulfill({ status: 409, json: { detail: 'Another owner updated this review. Refresh and compare the saved decision.' } }));
  await page.goto('/sales-data/data-quality?floor_id=first-floor&kind=customers');
  const note = page.getByTestId('analytics-duplicate-note-duplicate-customers');
  await note.fill('Keep this source comparison note while reviewing the conflict.');
  await page.getByTestId('analytics-duplicate-save-duplicate-customers').click();
  await expect(page.getByRole('alert')).toContainText('Another owner updated this review');
  await expect(note).toHaveValue('Keep this source comparison note while reviewing the conflict.');
  await expect(page.getByTestId('analytics-duplicate-save-duplicate-customers')).toBeEnabled();
  await analyticsFitsViewport(page);
});

for (const [tab, rowId, action, path, floor] of [
  ['quotations', 'quote-catalog', 'Open quotation source', '/tiles/quotation', 'ground-floor'],
  ['quotations', 'quote-sanitary', 'Open quotation source', '/quotations/quote-sanitary', 'first-floor'],
  ['quotations', 'quote-kitchen', 'Open quotation source', '/kitchen/project-kitchen', 'second-floor'],
  ['projects', 'project-kitchen', 'Open project', '/kitchen/project-kitchen', 'second-floor'],
]) test(`profile ${tab} source ${rowId} opens its canonical workspace after selecting its floor`, async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto(`/sales-data/profile/customers/customer-a?floor_id=all&tab=${tab}&preset=custom&date_from=2026-10-01&date_to=2026-10-28`);
  const identity = page.getByTestId(`analytics-row-${rowId}`);
  await expect(identity).toBeVisible();
  // The action shares the source row's outer record group with its stable ID.
  const group = identity.locator('..');
  await group.getByRole('button', { name: action, exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe(floor);
  expect(new URL(page.url()).searchParams.get('floor_id')).toBe(floor);
  if (rowId === 'quote-catalog') expect(new URL(page.url()).searchParams.get('id')).toBe('quote-catalog');
  expect(new URL(page.url()).searchParams.get('customer_id')).toBe('customer-a');
  await analyticsFitsViewport(page);
});

test('floor detail filters can switch to another business unit and back to overall sales', async ({ page }) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data/floor/ground-floor?floor_id=ground-floor&date_basis=confirmation');
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹60,000.5');
  await analyticsFloor(page, 'third-floor');
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('RNB 75,000.5');
  expect(new URL(page.url()).searchParams.get('floor_id')).toBe('third-floor');
  await expect(page.getByRole('heading', { name: 'Furniture overview', exact: true })).toBeVisible();
  await analyticsFloor(page, 'all');
  await expect(page.getByRole('heading', { name: 'Company overview', exact: true })).toBeVisible();
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹3,00,000.5');
  await expect(page.getByTestId('analytics-kpi-sales')).not.toContainText('RNB');
  await expect(page.getByTestId('analytics-furniture')).toContainText('RNB 75,000.5');
  expect(new URL(page.url()).pathname).toBe('/sales-data');
  await analyticsFitsViewport(page);
});

test('chart timestamp bounds display India calendar dates and apply unchanged without losing precision', async ({ page }) => {
  const start = '2026-10-09T18:30:00Z';
  const end = '2026-10-10T18:30:00Z';
  await mockSalesAnalytics(page, { dashboard: route => {
    const dashboard = analyticsDashboard('first-floor');
    dashboard.trend[0] = { ...dashboard.trend[0], start, end };
    return route.fulfill({ json: dashboard });
  } });
  await page.goto('/sales-data?floor_id=first-floor&date_basis=confirmation');
  await page.getByTestId('analytics-point-2026-10-10').click();
  await expect(page.getByTestId('analytics-record-order-a')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('date_from')).toBe(start);
  expect(new URL(page.url()).searchParams.get('date_to')).toBe(end);
  await page.getByTestId('analytics-filter-open').click();
  await expect(page.getByTestId('analytics-date-from')).toHaveValue('2026-10-10');
  await expect(page.getByTestId('analytics-date-to')).toHaveValue('2026-10-10');
  await page.getByTestId('analytics-filter-apply').click();
  await expect(page.getByRole('dialog', { name: 'Filter sales analytics', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('date_from')).toBe(start);
  expect(new URL(page.url()).searchParams.get('date_to')).toBe(end);
  await expect(page.getByTestId('analytics-record-order-a')).toBeVisible();
  await analyticsFitsViewport(page);
});

test('chart modes, exact values and keyboard controls use the same recorded data', async ({ page }, info) => {
  await mockSalesAnalytics(page);
  await page.goto('/sales-data?floor_id=first-floor');
  await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹2,40,000');
  const chart = page.getByTestId('analytics-trend');
  await chart.getByRole('button', { name: 'Explore dates', exact: true }).click();
  await expect(chart).toContainText('₹2,40,000');
  await chart.getByRole('button', { name: 'Bars', exact: true }).click();
  await expect(chart.getByRole('button', { name: 'Bars', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await chart.getByRole('button', { name: 'Chart data', exact: true }).click();
  await expect(chart.getByRole('link', { name: '10 Oct: ₹2,40,000. Open details', exact: true })).toBeVisible();
  await chart.getByRole('button', { name: 'View supporting orders', exact: true }).focus();
  await page.keyboard.press('Enter');
  const query = new URL(page.url()).searchParams;
  expect(query.get('currency')).toBe('INR');
  expect(query.get('floor_id')).toBe('first-floor');
  await expect(page.getByTestId('analytics-record-order-a')).toBeVisible();
  await analyticsFitsViewport(page);
  await page.goto('/sales-data');
  await expect(page.getByTestId('analytics-trend')).toBeVisible();
  expect(await page.getByTestId('analytics-page').evaluate(root => Array.from(root.querySelectorAll('a,[role="link"]')).every(node => getComputedStyle(node).textDecorationLine !== 'underline'))).toBe(true);
  await page.screenshot({ path: info.outputPath('owner-overview-top.png') });
});


test('currency drilldown cannot hide Furniture and customer segment links remain available',async({page})=>{
 await mockSalesAnalytics(page);
 await page.goto('/sales-data/records?currency=INR');
 await page.getByTestId('analytics-nav-dashboard').click();
 expect(new URL(page.url()).searchParams.get('currency')).toBeFalsy();
 await expect(page.getByTestId('analytics-furniture')).toContainText('RNB 75,000.5');
 await page.goto('/sales-data?currency=INR');
 await analyticsFloor(page,'third-floor');
 expect(new URL(page.url()).searchParams.get('currency')).toBeFalsy();
 await expect(page.getByTestId('analytics-kpi-sales')).toContainText('RNB 75,000.5');
 await page.goto('/sales-data');
 await page.getByRole('link',{name:/New customers: 3/}).click();
 expect(new URL(page.url()).searchParams.get('dimension')).toBe('new');
});
