import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const labels = { 'first-floor': 'Sanitary purchase', 'ground-floor': 'Tiles purchase', 'second-floor': 'Kitchen purchase', 'third-floor': 'Furniture purchase' };
for (const [floor, product] of Object.entries(labels)) {
  test(`critical ${floor} Purchases only shows its own items, customers and facets`, async ({ page }) => {
    await mockSession(page, '/purchases', false);
    await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floor);
    const reads: string[] = [];
    await page.route('**/api/purchases/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const requestFloor = route.request().headers()['x-floor-id'];
      reads.push(requestFloor);
      const name = labels[requestFloor as keyof typeof labels];
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
    await expect(page.getByText(product, { exact: true }).first()).toBeVisible();
    for (const other of Object.values(labels).filter(label => label !== product)) {
      await expect(page.getByText(other, { exact: true })).toHaveCount(0);
    }
    await page.getByTestId('view-customers').click();
    await expect(page.getByText(`${product} customer`, { exact: true }).first()).toBeVisible();
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(id => id === floor)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
