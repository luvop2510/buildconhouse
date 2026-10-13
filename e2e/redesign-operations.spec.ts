import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical mobile tile editor retains document details and explicitly retries a failed save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSession(page, '/tiles/selection');
  await page.route('**/api/customers', r => r.fulfill({ json: r.request().method() === 'POST' ? { id: 'tile-customer', name: 'Tile customer', phone: null } : [] }));
  const writes: any[] = [];
  await page.route('**/api/quotations', r => { writes.push(r.request().postDataJSON()); return r.fulfill({ status: 503, json: { detail: 'Save unavailable' } }); });
  await page.goto('/tiles/selection');
  await expect(page.getByTestId('mobile-reference')).toHaveCount(0);
  const details = page.getByRole('button', { name: 'Document details', exact: true });
  await details.click();
  await page.getByTestId('mobile-reference').fill('Architect discussion');
  await details.click();
  await page.getByLabel('Customer name', { exact: true }).fill('Tile customer');
  await expect(page.getByRole('alert').filter({ hasText: 'Changes are not saved' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ customer_id: 'tile-customer', doc_type: 'tiles_selection', reference_source: 'Architect discussion' });
  await details.click();
  await expect(page.getByTestId('mobile-reference')).toHaveValue('Architect discussion');
});

test('critical notebook conversion retains price and concurrency token after failure', async ({ page }) => {
  await mockSession(page, '/notebook/kitchen');
  const row = { id: 'lead-one', customer_name: 'Kitchen customer', customer_phone: '9000000000', address: 'Project site', kitchen_type: 'GI', referred_by: '', referrer_id: null, referrer_name: '', referrer_type: null, architect_interior_designer: '', status: 'pending', notes: 'Confirm measurements', lost_reason: '', is_converted: false, converted_at: null, last_contacted_at: null, contact_attempts: 0, updated_at: '2026-09-01T12:00:00Z', quotation_price: null };
  await page.route('**/api/followups/notebook/second-floor?**', r => r.fulfill({ json: { rows: [row], next_cursor: null } }));
  const writes: any[] = [];
  let fail = true;
  await page.route('**/api/followups/notebook/second-floor/lead-one/convert', r => {
    writes.push(r.request().postDataJSON());
    return fail ? r.fulfill({ status: 503, json: { detail: 'Conversion unavailable' } }) : r.fulfill({ json: { ...row, is_converted: true, quotation_price: 12500.5 } });
  });
  await page.goto('/notebook/kitchen');
  await page.getByRole('button', { name: 'Move to quotation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to quotation follow-up', exact: true });
  await dialog.getByLabel('Quotation price *', { exact: true }).fill('12500.50');
  await expect(dialog.getByLabel('Follow-up note *', { exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Move to quotation follow-up', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Conversion unavailable');
  await expect(dialog.getByLabel('Quotation price *', { exact: true })).toHaveValue('12500.50');
  fail = false;
  await dialog.getByRole('button', { name: 'Move to quotation follow-up', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('No walk-ins yet', { exact: true })).toBeVisible();
  expect(writes).toEqual([
    { quotation_price: 12500.5, updated_at: row.updated_at },
    { quotation_price: 12500.5, updated_at: row.updated_at },
  ]);
});

test('critical tile release keeps selected split quantities until the server accepts them', async ({ page }) => {
  await mockSession(page, '/tiles/orders/po/po-one');
  let remaining = 10;
  await page.route('**/api/tile-orders/purchase-orders/po-one', r => r.fulfill({ json: {
    id: 'po-one', number: 'PO-101', customer_name: 'Tile customer', supplier_name: 'Tile supplier', brand_id: 'brand-one', brand_name: 'Tile brand', overall_status: 'Pending',
    delivery_name: 'Tile customer', delivery_phone: '9000000000', delivery_address: 'Project site', delivery_city: 'Ahmedabad',
    items: [{ id: 'tile-one', name: 'Wall tile', series: null, finish: 'Matt', size: '600 × 600', sku: 'T-101', qty: 10, boxes_ready: 10 - remaining, boxes_godown: 0, boxes_dispatched: 0, boxes_pending: remaining, quantity_unit: 'Pieces', current_location: 'Supplier', overall_status: 'Pending' }],
  } }));
  const writes: any[] = [];
  let fail = true;
  await page.route('**/api/tile-orders/purchase-orders/po-one/ready', r => {
    const body = r.request().postDataJSON(); writes.push(body);
    if (fail) return r.fulfill({ status: 503, json: { detail: 'Release unavailable' } });
    remaining -= body.items[0].qty;
    return r.fulfill({ json: { po_id: 'po-one', ready_batches: [], overall_status: 'Ready' } });
  });
  await page.goto('/tiles/orders/po/po-one');
  await page.getByTestId('tile-release-quantity-tile-one').fill('4');
  await page.getByTestId('tile-release-selected').click();
  await expect(page.getByRole('alert')).toContainText('Release unavailable');
  await expect(page.getByTestId('tile-release-quantity-tile-one')).toHaveValue('4');
  fail = false;
  await page.getByTestId('tile-release-selected').click();
  await expect(page.getByTestId('tile-release-quantity-tile-one')).toHaveValue('');
  expect(remaining).toBe(6);
  expect(writes).toEqual([{ items: [{ po_item_id: 'tile-one', qty: 4 }] }, { items: [{ po_item_id: 'tile-one', qty: 4 }] }]);
});

test('critical tile movement validates availability and dispatch failure retains transport details', async ({ page }, info) => {
  await mockSession(page, '/tiles/orders/order-one');
  let released = 6;
  let godown = 0;
  await page.route('**/api/tile-orders/customer-orders/order-one', r => r.fulfill({ json: {
    summary: { id: 'order-one', number: 'TO-101', customer_name: 'Tile customer', order_date: '2026-09-01T12:00:00Z', brand_count: 1, total_products: 1, total_boxes: 10, completion_percentage: 0, waiting_days: 1, ageing_band: 'green', overall_status: 'Ready' },
    suppliers: [{ purchase_order_id: 'po-one', supplier_name: 'Tile supplier', brand_id: 'brand-one', brand_name: 'Tile brand', overall_status: 'Ready', items: [{ po_item_id: 'tile-one', tile_name: 'Wall tile', series: null, finish: 'Matt', size: '600 × 600', sku: 'T-101', boxes_ordered: 10, boxes_ready: released, boxes_godown: godown, boxes_dispatched: 0, boxes_pending: 4, quantity_unit: 'Box', current_location: 'Supplier', overall_status: 'Ready' }] }],
  } }));
  const movements: any[] = [];
  await page.route('**/api/tile-orders/purchase-orders/po-one/items/move-to-godown', r => {
    const body = r.request().postDataJSON(); movements.push(body);
    released -= body.items[0].qty; godown += body.items[0].qty;
    return r.fulfill({ json: { po_id: 'po-one', moved: [] } });
  });
  let dispatchBody: any;
  await page.route('**/api/tile-orders/purchase-orders/po-one/dispatch-from-released', r => {
    dispatchBody = r.request().postDataJSON();
    return r.fulfill({ status: 503, json: { detail: 'Dispatch unavailable' } });
  });
  await page.goto('/tiles/orders/order-one');
  await page.getByTestId('tile-order-move-godown-tile-one').click();
  const move = page.getByRole('dialog', { name: 'Move to Godown', exact: true });
  const qty = move.getByLabel('Enter quantity for Wall tile', { exact: true });
  await expect(qty).toHaveValue('6');
  await qty.fill('7');
  await expect(qty).toHaveAttribute('aria-invalid', 'true');
  await expect(move.getByRole('button', { name: 'Confirm Move', exact: true })).toBeDisabled();
  await qty.fill('2');
  await move.getByRole('button', { name: 'Confirm Move', exact: true }).click();
  await expect(move).toHaveCount(0);
  expect(movements).toEqual([{ items: [{ po_item_id: 'tile-one', qty: 2 }] }]);
  await page.getByTestId('tile-order-dispatch-released-tile-one').click();
  const dispatch = page.getByRole('dialog', { name: 'Dispatch from Released', exact: true });
  await expect(dispatch.getByLabel('Enter quantity for Wall tile', { exact: true })).toHaveValue('4');
  await dispatch.getByTestId('tile-dispatch-vehicle-number').fill('GJ-01-AB-1234');
  await dispatch.getByTestId('tile-dispatch-labor-cost').fill('125.50');
  await dispatch.getByRole('button', { name: 'Confirm Dispatch', exact: true }).click();
  await expect(dispatch.getByRole('alert')).toContainText('Dispatch unavailable');
  await expect(dispatch.getByTestId('tile-dispatch-vehicle-number')).toHaveValue('GJ-01-AB-1234');
  expect(dispatchBody).toMatchObject({ items: [{ po_item_id: 'tile-one', qty: 4 }], vehicle_number: 'GJ-01-AB-1234', labor_cost: 125.5 });
  await page.screenshot({ path: info.outputPath('tile-dispatch-recovery.png'), fullPage: true, animations: 'disabled' });
});
