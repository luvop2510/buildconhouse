import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const stamp = '2026-10-01T10:00:00Z';

test('critical closing a loading tile timeline keeps it closed when the request finishes', async ({ page }) => {
  await mockSession(page, '/tiles/orders/feedback-order', false);
  const health = captureRuntimeHealth(page);
  await page.route('**/api/tile-orders/customer-orders/feedback-order', route => route.fulfill({ json: {
    summary: { id: 'feedback-order', number: 'TO-FEEDBACK', customer_name: 'Feedback customer', order_date: stamp, brand_count: 0,
      total_products: 0, total_boxes: 0, completion_percentage: 0, waiting_days: 4, ageing_band: 'green', overall_status: 'Pending' }, suppliers: [],
  } }));
  let release!: () => void;
  let finished!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { finished = resolve; });
  await page.route('**/api/tile-orders/customer-orders/feedback-order/timeline', async route => {
    await pending;
    await route.fulfill({ json: { events: [{ id: 'event', summary: 'Material released', created_at: stamp, actor_name: 'Operator', event_type: 'material.released' }] } }).catch(() => {});
    finished();
  });
  try {
    await page.goto('/tiles/orders/feedback-order');
    await page.getByTestId('tile-order-actions').click();
    await page.getByTestId('tile-order-view-timeline').click();
    const sheet = page.getByTestId('tile-order-timeline-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('progressbar', { name: 'Loading order timeline…' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    release();
    await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(sheet).toHaveCount(0);
    await page.getByTestId('tile-order-actions').click();
    await page.getByTestId('tile-order-view-timeline').click();
    await expect(page.getByTestId('tile-order-timeline-event-0')).toContainText('Material released');
    await health.assertHealthy();
  } finally { release(); }
});

test('critical tile release prevents duplicate submissions and preserves quantities on failure and refresh', async ({ page }) => {
  await mockSession(page, '/tiles/orders/po/feedback-po', false);
  const health = captureRuntimeHealth(page);
  let reads = 0;
  let writes = 0;
  let refresh!: () => void;
  const refreshPending = new Promise<void>(resolve => { refresh = resolve; });
  let reject!: () => void;
  const writePending = new Promise<void>(resolve => { reject = resolve; });
  await page.route('**/api/tile-orders/purchase-orders/feedback-po', async route => {
    reads += 1;
    if (reads > 1) await refreshPending;
    await route.fulfill({ json: {
      id: 'feedback-po', number: 'TPO-FEEDBACK', customer_name: 'Release feedback customer', brand_name: 'Tile Brand', overall_status: 'Pending',
      delivery_name: 'Customer', delivery_phone: '9000000000', delivery_address: 'Showroom', delivery_city: 'Mumbai',
      items: [{ id: 'feedback-line', name: 'Feedback tile', sku: 'FEEDBACK', size: '600 × 600', qty: 10, quantity_unit: 'Box',
        boxes_ready: reads > 1 ? 4 : 0, boxes_godown: 0, boxes_dispatched: 0, boxes_pending: reads > 1 ? 6 : 10, current_location: 'Pending', overall_status: 'Pending' }],
    } });
  });
  await page.route('**/api/tile-orders/purchase-orders/feedback-po/ready', async route => {
    writes += 1;
    expect(route.request().postDataJSON()).toEqual({ items: [{ po_item_id: 'feedback-line', qty: 4 }] });
    if (writes === 1) {
      await writePending;
      await route.fulfill({ status: 409, json: { detail: 'Release not accepted; review the current quantity.' } });
    } else await route.fulfill({ json: { po_id: 'feedback-po', ready_batches: [], overall_status: 'Pending' } });
  });
  try {
    await page.goto('/tiles/orders/po/feedback-po');
    const input = page.getByTestId('tile-release-quantity-feedback-line');
    await input.fill('4');
    await input.evaluate(node => node.setAttribute('data-draft-node', 'retained'));
    const release = page.getByTestId('tile-release-row-feedback-line');
    await release.evaluate(node => { (node as HTMLElement).click(); (node as HTMLElement).click(); });
    await expect.poll(() => writes).toBe(1);
    await expect(release).toBeDisabled();
    await expect(release).toHaveAttribute('aria-busy', 'true');
    reject();
    await expect(page.getByText('Release not accepted; review the current quantity.', { exact: true }).first()).toBeVisible();
    await expect(input).toHaveValue('4');
    await expect(input).toHaveAttribute('data-draft-node', 'retained');
    await expect(release).toBeEnabled();
    await release.click();
    await expect.poll(() => writes).toBe(2);
    await expect(page.getByRole('progressbar', { name: 'Updating release quantities…' })).toBeVisible();
    await expect(input).toHaveAttribute('data-draft-node', 'retained');
    refresh();
    await expect(input).toHaveAttribute('placeholder', 'Max 6 boxes');
    await expect(input).toHaveAttribute('data-draft-node', 'retained');
    await expect(input).toHaveValue('');
    await expect(page.getByRole('progressbar', { name: 'Updating release quantities…' })).toHaveCount(0);
    await health.assertHealthy();
  } finally { reject(); refresh(); }
});

test('critical dispatch saves cannot be dismissed and obsolete reads cannot reopen the record', async ({ page }) => {
  await mockSession(page, '/tiles/orders?tab=dispatch-list', false);
  const health = captureRuntimeHealth(page);
  let reads = 0, writes = 0;
  let holdRead = false;
  let finishWrite!: () => void, finishRead!: () => void, readComplete!: () => void;
  const pendingWrite = new Promise<void>(resolve => { finishWrite = resolve; });
  const pendingRead = new Promise<void>(resolve => { finishRead = resolve; });
  const completedRead = new Promise<void>(resolve => { readComplete = resolve; });
  const dispatchRow = { dispatch_id: 'feedback-dispatch', dispatch_number: 'TD-FEEDBACK', dispatch_date: stamp,
    customer_name: 'Dispatch feedback customer', brand_name: 'Tile Brand', tile_name: 'Dispatch tile', boxes: 4, quantity_unit: 'Box',
    source: 'Released', chalan_id: 'feedback-chalan', chalan_number: 'TC-FEEDBACK', status: 'Dispatched' };
  await page.route('**/api/tile-orders/dispatches?**', route => route.fulfill({ json: { rows: [dispatchRow], page: 1, total: 1, has_more: false } }));
  await page.route('**/api/tile-orders/brands?**', route => route.fulfill({ json: { brands: [{ brand_id: 'brand', brand_name: 'Still selected brand', active_orders: 2, max_supplier_silent_days: 1 }], page: 1, total: 1, has_more: false } }));
  await page.route('**/api/tile-orders/dispatches/feedback-dispatch', async route => {
    reads += 1;
    const held = holdRead;
    if (held) await pendingRead;
    await route.fulfill({ json: {
      dispatch: { id: 'feedback-dispatch', dispatch_number: 'TD-FEEDBACK', dispatch_date: stamp, dispatch_time: '10:00', source: 'released',
        destination_type: 'Customer', destination_name: 'Project site', destination_address: 'Showroom Road', destination_city: 'Mumbai',
        customer_name: 'Dispatch feedback customer', labor_cost: 0, created_by_name: 'Warehouse operator', godown_received_at: null, delivered_at: null, status: 'Dispatched' },
      chalan: { id: 'feedback-chalan', number: 'TC-FEEDBACK', vehicle_number: writes ? 'GJ-TEST-1234' : '', driver_name: '', receiver_name: '', reference_number: '', items: [] },
      brand: { id: 'brand', name: 'Tile Brand' }, purchase_order: { id: 'po', number: 'TPO-FEEDBACK' },
    } }).catch(() => {});
    if (held) readComplete();
  });
  await page.route('**/api/tile-orders/dispatches/feedback-dispatch/transport', async route => {
    writes += 1;
    expect(route.request().postDataJSON().vehicle_number).toBe('GJ-TEST-1234');
    await pendingWrite;
    await route.fulfill({ json: { updated: true } });
  });
  try {
    await page.goto('/tiles/orders?tab=dispatch-list');
    await page.getByTestId('tile-orders-open-dispatch-feedback-dispatch').click();
    const sheet = page.getByTestId('tile-dispatch-record-sheet');
    await page.getByTestId('tile-dispatch-edit').click();
    await page.getByTestId('tile-dispatch-edit-vehicle-number').fill('GJ-TEST-1234');
    const save = page.getByTestId('tile-dispatch-save-transport');
    await save.evaluate(node => { (node as HTMLElement).click(); (node as HTMLElement).click(); });
    await expect.poll(() => writes).toBe(1);
    await expect(page.getByRole('progressbar', { name: 'Saving dispatch changes', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Dispatch feedback customer', { exact: true })).toBeVisible();
    finishWrite();
    await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await page.getByTestId('tile-dispatch-edit').click();
    await expect(page.getByTestId('tile-dispatch-edit-vehicle-number')).toHaveValue('GJ-TEST-1234');
    await page.getByTestId('tile-dispatch-cancel-edit').click();
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    holdRead = true;
    await page.getByTestId('tile-orders-open-dispatch-feedback-dispatch').click();
    await expect.poll(() => reads).toBe(3);
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('tile-orders-tab-brands').click();
    await expect(page.getByTestId('tile-orders-brands-table')).toContainText('Still selected brand');
    finishRead();
    await completedRead;
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('tile-orders-tab-brands')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('tile-orders-brands-table')).toContainText('Still selected brand');
    await health.assertHealthy();
  } finally { finishWrite(); finishRead(); }
});
