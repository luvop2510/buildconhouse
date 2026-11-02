import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

// Ground routes through the tile-order screen and still needs its own action.
for (const floor of ['first-floor']) {
  test(`purchase deletion sends the selected ${floor} scope`, async ({ page }) => {
    await mockSession(page, '/purchase-orders/delete-po', false, { floorId: floor });
    await page.route('**/api/purchases/stages', route => route.fulfill({ json: [] }));
    await page.route('**/api/purchases/delete-po/order-detail', route => route.fulfill({ json: {
      id: 'delete-po', number: 'PO-DELETE', customer_id: 'buyer', customer_name: 'Buyer',
      floor_id: floor, status: 'ordered', brand_name: 'Example Company', status_history: [],
      attachments: [], stage: 'order', remaining_qty_by_item: {}, subtotal: 100,
      grand_total: 100, created_at: '2026-10-10T10:00:00Z', created_by_name: 'Owner',
      items: [{ id: 'item', product_id: 'product', name: 'Product', qty: 1, qty_received: 0,
        unit_cost: 100, stage: 'order_in_company' }], chalans: [],
    } }));
    let deleted = false;
    await page.route('**/api/purchase-orders/delete-po', route => {
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().headers()['x-floor-id']).toBe(floor);
      deleted = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/purchase-orders/delete-po');
    await page.getByTestId('delete-purchase-order').click();
    await expect.poll(() => deleted).toBe(true);
  });
}

test('ground tile purchase deletion uses the Ground floor scope', async ({ page }) => {
  await mockSession(page, '/tiles/orders/po/po-one', false, { floorId: 'ground-floor' });
  await page.route('**/api/tile-orders/purchase-orders/po-one', route => route.fulfill({ json: {
    id: 'po-one', number: 'PO-101', customer_name: 'Tile customer', supplier_name: 'Supplier',
    brand_id: 'brand', brand_name: 'Tile brand', overall_status: 'Pending',
    delivery_name: 'Tile customer', delivery_phone: '', delivery_address: '', delivery_city: '',
    items: [{ id: 'line', name: 'Tile', qty: 10, boxes_ready: 0, boxes_godown: 0,
      boxes_dispatched: 0, boxes_pending: 10, quantity_unit: 'Box', current_location: 'Supplier', overall_status: 'Pending' }],
  } }));
  let deleted = false;
  await page.route('**/api/purchase-orders/po-one', route => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    deleted = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/tiles/orders/po/po-one');
  await page.getByTestId('delete-tile-purchase-order').click();
  await expect.poll(() => deleted).toBe(true);
});
