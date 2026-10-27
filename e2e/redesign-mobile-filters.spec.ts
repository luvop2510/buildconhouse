import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { emptySalesSummary, mockSalesSummary } from './sales-fixtures';

test('critical mobile sales filters retain selected business units and unfinished date ranges while hidden', async ({ page }) => {
  let latest = new URLSearchParams();
  let requests = 0;
  await mockSalesSummary(page, { onSummary: route => {
    latest = new URL(route.request().url()).searchParams;
    requests += 1;
    return route.fulfill({ json: emptySalesSummary() });
  } });
  await page.goto('/sales-data/sales');
  const filters = page.getByTestId('sales-data-filters');
  const toggle = page.getByTestId('sales-data-filters-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByTestId('sales-data-floor-picker').click();
  await page.getByRole('dialog', { name: 'Business unit', exact: true }).getByRole('button', { name: 'Tiles', exact: true }).click();
  await expect.poll(() => latest.get('floor_id')).toBe('ground-floor');
  await page.getByTestId('sales-data-period-picker').click();
  await page.getByRole('dialog', { name: 'Reporting period', exact: true }).getByRole('button', { name: 'Custom range', exact: true }).click();
  await filters.getByLabel('From', { exact: true }).fill('2026-09-03');
  await filters.getByLabel('To', { exact: true }).fill('2026-09-17');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sales-data-filters-content')).toBeHidden();
  await expect(page.getByTestId('sales-kpi-products')).toContainText('0');
  const beforeRestore = requests;
  await toggle.click();
  await expect(filters.getByLabel('From', { exact: true })).toHaveValue('2026-09-03');
  await expect(filters.getByLabel('To', { exact: true })).toHaveValue('2026-09-17');
  await expect(page.getByTestId('sales-data-floor-picker')).toContainText('Tiles');
  expect(requests).toBe(beforeRestore);
  await filters.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect.poll(() => latest.get('preset')).toBe('custom');
  expect(latest.get('date_from')).toBe('2026-09-03T00:00:00+00:00');
  expect(latest.get('date_to')).toBe('2026-09-18T00:00:00+00:00');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('sales-data-filters-content')).toBeVisible();
});

test('critical phone tile content scrolls normally and its action footer hides throughout quantity editing', async ({ page }) => {
  const phone = page.viewportSize()!.width < 768;
  await mockSession(page, '/tiles/orders/po/mobile-filters', false);
  await page.route('**/api/tile-orders/purchase-orders/mobile-filters', route => route.fulfill({ json: {
    id: 'mobile-filters', number: 'PO-201', customer_name: 'Mobile customer', supplier_name: 'Tile supplier', brand_id: 'brand-one', brand_name: 'Tile brand', overall_status: 'Pending',
    delivery_name: 'Mobile customer', delivery_phone: '', delivery_address: '', delivery_city: '',
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `tile-${index}`, name: `Mobile floor tile ${index}`, series: null, finish: 'Matt', size: '600 × 600', sku: `T-${index}`, qty: 10,
      boxes_ready: 0, boxes_godown: 0, boxes_dispatched: 0, boxes_pending: 10, quantity_unit: 'Box', current_location: 'Supplier', overall_status: 'Pending',
    })),
  } }));
  await page.goto('/tiles/orders/po/mobile-filters');
  const table = page.getByTestId('tile-release-table');
  await expect(table.getByText('Mobile floor tile 0', { exact: true })).toBeVisible();
  if (phone) expect(await table.evaluate(element => [element, ...Array.from(element.querySelectorAll('*'))].some(node => getComputedStyle(node).position === 'sticky'))).toBe(false);
  const quantity = page.getByTestId('tile-release-quantity-tile-0');
  const footer = page.getByTestId('tile-release-action-bar');
  await quantity.scrollIntoViewIfNeeded();
  await expect(footer).toBeVisible();
  await quantity.fill('4');
  if (phone) await expect(footer).toHaveCount(0);
  else await expect(footer).toBeVisible();
  await quantity.fill('5');
  if (phone) await expect(footer).toHaveCount(0);
  else await expect(footer).toBeVisible();
  await quantity.blur();
  await expect(footer).toBeVisible();
  await expect(quantity).toHaveValue('5');
  const title = table.getByText('Mobile floor tile 0', { exact: true });
  const before = await title.boundingBox();
  await title.evaluate(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        parent.scrollTop += 180;
        return;
      }
    }
    throw new Error('Expected one page scroll owner around the tile cards');
  });
  await expect.poll(async () => (await title.boundingBox())!.y).toBeLessThan(before!.y - 100);
});
