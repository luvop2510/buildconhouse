import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const labels = { 'first-floor': 'Sanitary purchase', 'ground-floor': 'Tiles purchase', 'second-floor': 'Kitchen purchase', 'third-floor': 'Furniture purchase' };

test('critical Sanitary Purchases scopes items, customers and facets to its own floor', async ({ page }) => {
  await mockSession(page, '/purchases', false);
  const reads: { path: string; floor: string }[] = [];
  await page.route('**/api/purchases/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const floor = route.request().headers()['x-floor-id'];
    reads.push({ path: pathname, floor });
    const name = labels[floor as keyof typeof labels];
    const json = pathname.endsWith('/items/page') ? {
      items: [{ item_id: floor, po_id: floor, po_number: 'PO-TEST', name, sku: floor,
        customer_id: floor, customer_name: `${name} customer`, brand_id: floor, brand_name: `${name} brand`,
        stage: 'po_final', stage_label: 'PO Final', stage_tone: {}, qty: 1, unit_cost: 100,
        age_days: 0, sla_days: 7, blocked: false }], total: 1, next_skip: null,
      summaries: { blocked_count: 0, sla_days: 7, stage_counts: { po_final: 1 } },
    } : pathname.endsWith('/brands') ? { all: 1, brands: [{ id: floor, name: `${name} brand`, count: 1 }] }
      : pathname.endsWith('/stages') ? [{ key: 'po_final', label: 'PO Final', count: 1, tone: {} }]
        : pathname.endsWith('/shortages') ? { items: [] }
          : [{ id: floor, name: `${name} customer` }];
    return route.fulfill({ json });
  });
  await page.goto('/purchases');
  await page.getByTestId('view-stock').click();
  await expect(page.getByText(labels['first-floor'], { exact: true }).first()).toBeVisible();
  const mobileFilters = page.getByTestId('purchases-filter-button');
  if (await mobileFilters.isVisible()) {
    await mobileFilters.click();
    await expect(page.getByRole('button', { name: 'Sanitary purchase brand (1)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'PO Final (1)', exact: true })).toBeVisible();
    await page.getByTestId('apply-purchase-filters').click();
  } else await expect(page.getByText('Sanitary purchase brand', { exact: true }).first()).toBeVisible();
  for (const other of Object.values(labels).filter(label => label !== labels['first-floor'])) {
    await expect(page.getByText(other, { exact: true })).toHaveCount(0);
  }
  await page.getByTestId('view-customers').click();
  await expect(page.getByText('Sanitary purchase customer', { exact: true }).first()).toBeVisible();
  expect(reads.some(read => read.path.endsWith('/items/page'))).toBe(true);
  expect(reads.some(read => read.path.endsWith('/brands'))).toBe(true);
  expect(reads.some(read => read.path.endsWith('/stages'))).toBe(true);
  expect(reads.some(read => read.path.endsWith('/customer-workspaces'))).toBe(true);
  expect(reads.every(read => read.floor === 'first-floor')).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe('first-floor');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

for (const [floor, destination] of [['ground-floor', '/tiles'], ['second-floor', '/walkins'], ['third-floor', '/walkins']] as const) {
  test(`critical ${floor} denies direct Purchases URLs without reads or changing its floor`, async ({ page }) => {
    await mockSession(page, '/purchases', false);
    await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floor);
    const reads: string[] = [];
    await page.route(/\/api\/(?:purchases|purchase-orders)(?:\/|\?|$)/, route => {
      reads.push(route.request().url());
      return route.fulfill({ status: 403, json: { detail: 'Purchases belongs to Sanitary Bathroom' } });
    });
    for (const path of ['/purchases', '/purchases-completed', '/purchase-orders']) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${destination}$`));
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.getByTestId('view-stock')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Purchases', exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe(floor);
      expect(reads).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
