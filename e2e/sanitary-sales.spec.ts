import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { analyticsFitsViewport } from './sales-analytics-helpers';
import { captureRuntimeHealth } from './runtime-health';
import { mockSanitarySales, reportIds } from './sanitary-sales-fixtures';

const pagePath = '/sanitary-sales';

async function select(page: Page, id: string, value: string) {
  await page.getByTestId(id).click();
  await page.getByTestId(`${id}-${value}`).click();
}

async function saveFile(page: Page, testId: string) {
  const downloaded = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const mobile = await page.evaluate(() => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (mobile) await page.getByTestId('mobile-file-download').click();
  return downloaded;
}

test('six collapsed reports, accessible drilldown, saved PDF and exact currency fit the viewport', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  const requests = await mockSanitarySales(page);
  await page.goto(pagePath);
  await expect(page.getByRole('heading', { name: 'Sanitary Floor Sales Data' })).toBeVisible();
  const section = (id: string) => page.getByTestId(`sanitary-report-${id}`);
  for (const id of reportIds) {
    await expect(section(id)).toBeVisible();
    await expect(section(id)).toHaveAttribute('aria-expanded', 'false');
  }
  expect(requests.filter(url => reportIds.includes(url.pathname.split('/').at(-1) as typeof reportIds[number]))).toHaveLength(0);
  await analyticsFitsViewport(page, [section('pending-company'), page.getByTestId('sanitary-period'), page.getByTestId('sanitary-mrp')]);
  await page.screenshot({ path: info.outputPath('collapsed-reports.png'), fullPage: true });

  await section('pending-interior').focus();
  await page.keyboard.press('Enter');
  await expect(section('pending-interior')).toHaveAttribute('aria-expanded', 'true');
  const architect = page.getByTestId('sanitary-row-architect-ria');
  const buyer = page.getByTestId('sanitary-row-buyer-aarav');
  await expect(architect).toContainText(/2,00,000\.01/);
  await expect(buyer).toHaveCount(0);
  await architect.click();
  await expect(buyer).toContainText(/2,00,000\.01/);
  await buyer.click();
  await expect(page.getByText('SQ-103', { exact: true })).toBeVisible();
  await page.getByTestId('sanitary-row-q-103').click();
  await expect(page.getByText('Rainshower 310', { exact: true })).toBeVisible();
  await expect(page.getByText('9000000000', { exact: false })).toBeVisible();
  await analyticsFitsViewport(page, [architect, buyer, page.getByTestId('sanitary-pdf-q-103')]);
  await page.screenshot({ path: info.outputPath('pending-detail.png'), fullPage: true });
  const pdf = await saveFile(page, 'sanitary-pdf-q-103');
  expect(pdf.suggestedFilename()).toMatch(/^SQ-103(?:-latest)?\.pdf$/);
  expect(await readFile(await pdf.path(), 'utf8')).toMatch(/^%PDF-1\.4/);

  await section('placed-company').click();
  await expect(page.getByTestId('sanitary-row-buyer-aarav').last()).toContainText(/1,00,000\.25/);
  await page.screenshot({ path: info.outputPath('placed-summary.png'), fullPage: true });
  expect(requests.some(url => url.searchParams.get('group_id') === 'architect-ria'
    && url.searchParams.get('customer_id') === 'buyer-aarav')).toBe(true);
  await health.assertHealthy();
});

test('every Excel download applies report-specific brand and sorting plus shared dates and price basis', async ({ page }) => {
  const requests = await mockSanitarySales(page);
  await page.goto(pagePath);
  await page.getByTestId('sanitary-mrp').click();
  await select(page, 'sanitary-period', 'custom');
  await page.getByTestId('sanitary-date-from').fill('2026-10-10');
  await page.getByTestId('sanitary-date-to').fill('2026-10-20');
  await page.getByTestId('sanitary-apply-dates').click();
  for (const id of reportIds) {
    await page.getByTestId(`sanitary-report-${id}`).click();
    await select(page, `sanitary-brand-${id}`, 'hansgrohe');
    const sort = id === 'products' ? 'value' : id === 'interior-orders' ? 'customers' : undefined;
    if (sort) await select(page, `sanitary-sort-${id}`, sort);
    const file = await saveFile(page, `sanitary-export-${id}`);
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/i);
    const request = requests.find(url => url.pathname.endsWith(`/${id}/export`));
    expect(request?.searchParams.get('brand_id')).toBe('hansgrohe');
    expect(request?.searchParams.get('value_basis')).toBe('mrp');
    expect(request?.searchParams.get('preset')).toBe('custom');
    expect(request?.searchParams.get('date_from')).toBe('2026-10-10');
    expect(request?.searchParams.get('date_to')).toBe('2026-10-20');
    if (sort) expect(request?.searchParams.get('sort')).toBe(sort);
  }
});

test('a report error can be retried, and an empty brand keeps the report usable', async ({ page }) => {
  await mockSanitarySales(page, { failOnce: 'pending-company' });
  await page.goto(pagePath);
  await page.getByTestId('sanitary-report-pending-company').click();
  await page.getByRole('button', { name: /retry/i }).click();
  await expect(page.getByTestId('sanitary-row-buyer-aarav')).toBeVisible();
  await select(page, 'sanitary-brand-pending-company', 'vitra');
  await expect(page.getByTestId('sanitary-row-buyer-aarav')).toHaveCount(0);
  await expect(page.getByText(/no (matching |pending )?(records|quotations|results)/i)).toBeVisible();
  await expect(page.getByTestId('sanitary-brand-pending-company')).toBeVisible();
});

for (const profile of [{ role: 'manager' }, { floorId: 'ground-floor' }]) {
  test(`direct access keeps Sanitary report data private for ${profile.role || profile.floorId}`, async ({ page }) => {
    const requests = await mockSanitarySales(page, profile);
    await page.goto(pagePath);
    if (profile.role) {
      await expect(page.getByText('Owner access required', { exact: true })).toBeVisible();
    } else {
      await expect(page).toHaveURL(/\/tiles(?:[/?]|$)/);
    }
    await expect(page.getByTestId('sanitary-report-pending-company')).toHaveCount(0);
    expect(requests).toHaveLength(0);
  });
}

test('workspace navigation opens the dedicated report and date presets reset server pagination', async ({ page }) => {
  const requests = await mockSanitarySales(page, { pagedPending: true });
  await page.goto('/dashboard');
  if (page.viewportSize()!.width < 768) await page.getByTestId('bottom-nav-more').click();
  await page.getByRole('link', { name: 'Sanitary Sales Data', exact: true }).click();
  await expect(page).toHaveURL(/\/sanitary-sales(?:[/?]|$)/);
  await expect(page.getByRole('heading', { name: 'Sanitary Floor Sales Data' })).toBeVisible();

  await page.getByTestId('sanitary-report-pending-company').click();
  await expect(page.getByTestId('sanitary-row-buyer-1')).toBeVisible();
  await expect(page.getByText('1–15 of 17', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByTestId('sanitary-row-buyer-16')).toBeVisible();
  await expect(page.getByTestId('sanitary-row-buyer-1')).toHaveCount(0);

  await select(page, 'sanitary-period', 'last_7_days');
  await expect(page.getByTestId('sanitary-row-buyer-3')).toBeVisible();
  await expect(page.getByTestId('sanitary-row-buyer-4')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toHaveCount(0);
  await select(page, 'sanitary-period', 'last_30_days');
  await expect(page.getByText('1–15 of 16', { exact: true })).toBeVisible();
  await select(page, 'sanitary-period', 'all_time');
  await expect(page.getByText('1–15 of 17', { exact: true })).toBeVisible();

  const reads = requests.filter(url => url.pathname.endsWith('/pending-company'));
  for (const preset of ['last_7_days', 'last_30_days']) {
    expect(reads.some(url => url.searchParams.get('preset') === preset && url.searchParams.get('page') === '1')).toBe(true);
  }
  expect(reads.some(url => url.searchParams.get('preset') === 'all_time' && url.searchParams.get('page') === '2')).toBe(true);
});

test('a late Sanitary response cannot reappear after leaving its workspace', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await mockSanitarySales(page);
  const pendingCompany = /\/api\/sanitary-sales\/pending-company\?/;
  let unlock!: () => void;
  const held = new Promise<void>(resolve => { unlock = resolve; });
  let first = true;
  await page.route(pendingCompany, async route => {
    if (!first) return route.fallback();
    first = false;
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    await held;
    const metrics = {
      value: 42, mrp_value: 42, offer_value: 42, missing_value_lines: 0, missing_mrp_lines: 0,
      missing_offer_lines: 0, customer_count: 1, document_count: 1,
    };
    await route.fulfill({ json: {
      level: 'groups', items: [{ ...metrics, id: 'old-customer', name: 'Late response customer', brands: [], statuses: ['draft'] }],
      totals: metrics, notes: [], page: 1, page_size: 15, total: 1, date_from: null, date_to: null,
    } }).catch(() => { /* Leaving the route can abort the held browser request. */ });
  });
  await page.goto(pagePath);
  const section = page.getByTestId('sanitary-report-pending-company');
  try {
    const requested = page.waitForRequest(pendingCompany);
    await section.click();
    await requested;
    await page.getByTestId('floor-switcher').click();
    await page.getByRole('menuitem', { name: 'Ground Floor', exact: true }).click();
    await expect(page).toHaveURL(/\/tiles(?:[/?]|$)/);
    await expect(section).toHaveCount(0);
  } finally {
    unlock();
  }
  await expect(page.getByText('Late response customer', { exact: true })).toHaveCount(0);
  await page.getByTestId('floor-switcher').click();
  await page.getByRole('menuitem', { name: 'The Sanitary Bathroom', exact: true }).click();
  if (page.viewportSize()!.width < 768) await page.getByTestId('bottom-nav-more').click();
  await page.getByRole('link', { name: 'Sanitary Sales Data', exact: true }).click();
  await section.click();
  await expect(page.getByTestId('sanitary-row-buyer-aarav')).toBeVisible();
  await expect(page.getByText('Late response customer', { exact: true })).toHaveCount(0);
  await health.assertHealthy();
});
