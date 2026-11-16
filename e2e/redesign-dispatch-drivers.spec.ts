import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const item = { po_item_id: 'driver-item', tile_name: 'Ivory', sku: 'IVORY-MATT', finish: 'Matt', size: '600x600',
  boxes_ordered: 10, boxes_ready: 4, boxes_godown: 6, boxes_pending: 0, boxes_dispatched: 0, quantity_unit: 'Box', current_location: 'Godown', overall_status: 'Ready' };
const summary = { id: 'driver-order', number: 'TO-DRIVER', customer_name: 'Driver test customer', order_date: '2026-11-01',
  brand_count: 1, total_products: 1, total_boxes: 10, completion_percentage: 0, overall_status: 'Ready', waiting_days: 1, ageing_band: 'green' };
const group = { purchase_order_id: 'driver-po', brand_name: 'Tile brand', overall_status: 'Ready', items: [item] };

for (const source of ['released', 'godown'] as const) test(`critical saved driver autofills editable details for dispatch from ${source}`, async ({ page }, info) => {
  await mockSession(page, '/tiles/orders/driver-order', false);
  const health = captureRuntimeHealth(page);
  await page.route('**/api/tile-orders/customer-orders/driver-order', route => route.fulfill({ json: { summary, suppliers: [group] } }));
  await page.route('**/api/tile-orders/drivers?**', route => {
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    return route.fulfill({ json: { drivers: [{ name: 'Rameshbhai', mobile: '9876543210', vehicle_number: 'GJ-01-1000' }] } });
  });
  let body: any;
  await page.route(`**/api/tile-orders/purchase-orders/driver-po/dispatch-from-${source}`, route => {
    body = route.request().postDataJSON();
    return route.fulfill({ status: 409, json: { detail: 'Refresh quantities and retry.' } });
  });
  await page.goto('/tiles/orders/driver-order');
  await page.getByTestId('tile-order-actions-driver-item').click();
  await page.getByTestId(`tile-order-dispatch-${source}-driver-item`).click();
  await page.getByTestId('tile-dispatch-driver-search').fill('Ramesh');
  const option = page.getByRole('button', { name: 'Use driver Rameshbhai, 9876543210' });
  await expect(option).toBeVisible();
  expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await option.click();
  await expect(page.getByTestId('tile-dispatch-driver-name')).toHaveValue('Rameshbhai');
  await expect(page.getByTestId('tile-dispatch-driver-mobile')).toHaveValue('987-654-32-10');
  await expect(page.getByTestId('tile-dispatch-vehicle-number')).toHaveValue('GJ-01-1000');
  await expect(page.getByTestId('tile-dispatch-receiver-name')).toHaveValue('');
  await expect(page.getByTestId('tile-dispatch-reference-number')).toHaveValue('');
  await page.getByTestId('tile-dispatch-vehicle-number').fill('GJ-01-2000');
  await page.getByTestId('tile-dispatch-receiver-name').fill('This trip receiver');
  await page.getByRole('button', { name: 'Confirm Dispatch', exact: true }).click();
  await expect.poll(() => body?.driver_mobile).toBe('9876543210');
  expect(body).toMatchObject({ driver_name: 'Rameshbhai', vehicle_number: 'GJ-01-2000', receiver_name: 'This trip receiver', items: [{ po_item_id: 'driver-item', qty: source === 'released' ? 4 : 6 }] });
  await expect(page.getByText('Refresh quantities and retry.', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('tile-dispatch-vehicle-number')).toHaveValue('GJ-01-2000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(`driver-${source}.png`), fullPage: true });
  await health.assertHealthy();
});

test('critical dispatch-board creation reuses a driver without copying trip fields', async ({ page }) => {
  await mockSession(page, '/tiles/orders?tab=dispatch-list', false);
  const health = captureRuntimeHealth(page);
  await page.route('**/api/tile-orders/dispatches?**', route => route.fulfill({ json: { rows: [], page: 1, total: 0, has_more: false } }));
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: [{ ...summary, brands: [{ brand_name: 'Tile brand' }] }], page: 1, total: 1, has_more: false } }));
  await page.route('**/api/tile-orders/customer-orders/driver-order', route => route.fulfill({ json: { summary, suppliers: [group] } }));
  await page.route('**/api/tile-orders/drivers?**', route => route.fulfill({ json: { drivers: [{ name: 'Rameshbhai', mobile: '9876543210', vehicle_number: 'GJ-01-1000' }] } }));
  await page.goto('/tiles/orders?tab=dispatch-list');
  await page.getByTestId('tile-orders-create-dispatch').click();
  await page.getByTestId('tile-create-dispatch-order-driver-order').click();
  await page.getByTestId('tile-create-dispatch-group-driver-po').click();
  await page.getByTestId('tile-create-dispatch-driver-search').fill('9876');
  await page.getByRole('button', { name: 'Use driver Rameshbhai, 9876543210' }).click();
  await expect(page.getByTestId('tile-create-dispatch-driver-name')).toHaveValue('Rameshbhai');
  await expect(page.getByTestId('tile-create-dispatch-driver-mobile')).toHaveValue('987-654-32-10');
  await expect(page.getByTestId('tile-create-dispatch-vehicle-number')).toHaveValue('GJ-01-1000');
  await expect(page.getByTestId('tile-create-dispatch-receiver-name')).toHaveValue('');
  await expect(page.getByTestId('tile-create-dispatch-reference-number')).toHaveValue('');
  await health.assertHealthy();
});

test('critical Godown shows persisted quantities with their correct variants and units', async ({ page }, info) => {
  await mockSession(page, '/tiles/orders?tab=inventory', false);
  const health = captureRuntimeHealth(page);
  const rows = [
    { id: 'box-lot', customer: 'Godown customer', name: 'Ivory', brand: 'Tile brand', product: 'IVORY-MATT', size: '600x600', finish: 'Matt', quantity: 4, quantity_unit: 'Box', arrival_date: '2026-11-01' },
    { id: 'piece-lot', customer: 'Godown customer', name: 'Ivory', brand: 'Tile brand', product: 'IVORY-GLOSSY', size: '1200x2400', finish: 'Glossy', quantity: 5, quantity_unit: 'Pieces', arrival_date: '2026-11-01' },
  ];
  await page.route('**/api/tile-orders/inventory?**', route => route.fulfill({ json: { rows, page: 1, page_size: 30, total: 2, has_more: false } }));
  await page.goto('/tiles/orders?tab=inventory');
  for (let refresh = 0; refresh < 2; refresh++) {
    const table = page.getByTestId('tile-orders-inventory-table');
    await expect(table.getByText('4 boxes', { exact: true })).toBeVisible();
    await expect(table.getByText('5 pieces', { exact: true })).toBeVisible();
    await expect(table.getByText('Ivory · Matt', { exact: true })).toBeVisible();
    await expect(table.getByText('Ivory · Glossy', { exact: true })).toBeVisible();
    if (refresh === 0) await page.reload();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('godown-quantities.png'), fullPage: true });
  await health.assertHealthy();
});
