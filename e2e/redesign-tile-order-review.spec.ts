import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const preview = {
  quotation_id: 'tile-review', quotation_number: 'TQ-REVIEW', doc_type: 'tiles_quotation',
  customer_id: 'tile-review-customer', customer_name: 'Tile order customer', total_value: 2000,
  brands: [{ brand_id: 'tile-brand', brand_name: 'Tile brand', subtotal: 2000, item_count: 1,
    items: [{ line_id: 'tile-line', product_id: 'tile-product', sku: 'TILE-01', name: 'Floor tile', qty: 10, unit_cost: 200, quantity_unit: 'Box' }] }],
};

test('critical Ground Floor order review places a tile order without Sanitary supplier access', async ({ page }) => {
  await mockSession(page, '/tiles/place-order/tile-review', false);
  const supplierReads: string[] = [];
  const orders: string[] = [];
  await page.route('**/api/suppliers', route => {
    supplierReads.push(route.request().url());
    return route.fulfill({ status: 403, json: { detail: 'Purchases are only available on The Sanitary Bathroom floor' } });
  });
  await page.route('**/api/quotations/tile-review/place-order/preview', route => route.fulfill({ json: preview }));
  await page.route('**/api/quotations/tile-review/place-order/confirm', route => {
    orders.push(route.request().headers()['x-floor-id']);
    return route.fulfill({ json: { count: 1, purchase_orders: [{ id: 'tile-po' }] } });
  });
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: [], has_more: false, page: 1 } }));
  await page.goto('/tiles/place-order/tile-review');
  await expect(page.getByText('Tile order customer', { exact: true })).toBeVisible();
  await expect(page.getByText('Floor tile', { exact: true })).toBeVisible();
  await expect(page.getByText('Supplier', { exact: true })).toHaveCount(0);
  await page.getByTestId('confirm-place-order').click();
  await expect(page.getByTestId('tile-orders-screen')).toBeVisible();
  expect(supplierReads).toHaveLength(0);
  expect(orders).toEqual(['ground-floor']);
});
