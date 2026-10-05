import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function builderReferences(page: Page) {
  await page.route('**/api/customers', route => route.fulfill({ json: [{ id: 'client', name: 'Fixture Customer' }] }));
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
}
const quotationDoc = (id: string, floor_id: string, doc_type = 'standard') => ({
  id, number: 'Q-FLOOR-TEST', doc_type, floor_id, customer_id: 'client', customer_name: 'Fixture Customer',
  status: 'ordered', items: [], rooms: ['Bathroom'], subtotal: 1200, discount_total: 0, grand_total: 1200,
  created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z',
});

test('critical sanitary deep link synchronizes the floor before fetching an existing quotation', async ({ page }) => {
  await mockSession(page, '/tiles');
  await builderReferences(page);
  const requestedFloors: string[] = [];
  await page.route('**/api/quotations/sanitary-order', route => {
    requestedFloors.push(route.request().headers()['x-floor-id']);
    return route.fulfill({ json: quotationDoc('sanitary-order', 'first-floor') });
  });
  await page.goto('/quotations/new?quotationId=sanitary-order');
  await expect.poll(() => requestedFloors.length).toBeGreaterThan(0);
  expect(requestedFloors.every(floor => floor === 'first-floor')).toBe(true);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe('first-floor');
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
});

test('critical Payments update opens the Ground Floor document with its correct request floor', async ({ page }) => {
  await mockSession(page, '/payments');
  await builderReferences(page);
  const tile = quotationDoc('tile-payment-order', 'ground-floor', 'tiles_quotation');
  const order = { ...tile, customer_id: 'client', paid: 0, outstanding: 1200, percent_collected: 0, payment_status: 'due', confirmed_at: '2026-10-01T10:00:00Z', days_unpaid: 4 };
  await page.route('**/api/payments/orders', route => route.fulfill({ json: [order] }));
  await page.route('**/api/payments/orders/tile-payment-order', route => route.fulfill({ json: {
    ...order, customer: { id: 'client', name: 'Fixture Customer' }, mrp: 1200, discounted_rate: 1200,
    quotation_total: 1200, manual_extra_amount: 0, payments: [],
  } }));
  const requestedFloors: string[] = [];
  await page.route('**/api/quotations/tile-payment-order', route => {
    requestedFloors.push(route.request().headers()['x-floor-id']);
    return route.fulfill({ json: tile });
  });
  await page.goto('/payments');
  await page.getByTestId('payment-edit-quotation').scrollIntoViewIfNeeded();
  await page.getByTestId('payment-edit-quotation').click();
  await expect(page).toHaveURL(/\/tiles\/quotation\?id=tile-payment-order$/);
  await expect.poll(() => requestedFloors.length).toBeGreaterThan(0);
  expect(requestedFloors.every(floor => floor === 'ground-floor')).toBe(true);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe('ground-floor');
  await expect(page.getByText('Could not restore quotation', { exact: true })).toHaveCount(0);
});

test('critical zero-stock inventory stays listed and has no available transfer or quotation actions', async ({ page }) => {
  await mockSession(page, '/godown-stock');
  let requestedHistory = false;
  await page.route('**/api/godown-stock?**', route => {
    requestedHistory = new URL(route.request().url()).searchParams.get('include_history') === 'true';
    return route.fulfill({ json: { lots: [{ id: 'empty-lot', product_id: 'product', sku: 'EMPTY-1', name: 'Empty Basin Mixer', qty_received: 5, available_qty: 0, transferable_qty: 0, stock_value: 0 }], brands: [], total_available_qty: 0, total_stock_value: 0, unpriced_lot_count: 0 } });
  });
  await page.goto('/godown-stock');
  await expect(page.getByText('Empty Basin Mixer', { exact: true })).toBeVisible();
  await expect(page.getByText('Out of stock · 0 units · ₹0 stock value', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Transfer Empty Basin Mixer to a customer' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Add Empty Basin Mixer.*to a new quotation/ })).toBeDisabled();
  expect(requestedHistory).toBe(true);
  const families = await page.getByText('Empty Basin Mixer', { exact: true }).evaluate(element => ({ text: getComputedStyle(element).fontFamily, icons: Array.from(document.querySelectorAll('[style*="feather"]')).map(icon => getComputedStyle(icon).fontFamily) }));
  expect(families.text).toContain('Inter-SemiBold');
  expect(families.icons.length).toBeGreaterThan(0);
  expect(families.icons.every(family => family.toLowerCase().includes('feather'))).toBe(true);
});

test('critical a deep-linked fully loaned godown lot cannot seed an unavailable quotation line', async ({ page }) => {
  await mockSession(page, '/quotations/new');
  await builderReferences(page);
  await page.route('**/api/godown-stock/loaned-lot', route => route.fulfill({ json: { id: 'loaned-lot', name: 'Loaned Basin Mixer', sku: 'LOANED-1', available_qty: 5, transferable_qty: 0 } }));
  await page.goto('/quotations/new?godownStockId=loaned-lot');
  await expect(page.getByText('That godown lot is no longer available', { exact: true })).toBeVisible();
  await expect(page.getByText('Loaned Basin Mixer', { exact: true })).toHaveCount(0);
});

test('critical transferring the last godown unit refreshes inventory and preserves its zero-stock history', async ({ page }) => {
  await mockSession(page, '/godown-stock');
  let available = 1;
  const lot = () => ({ id: 'last-lot', product_id: 'product', sku: 'LAST-1', name: 'Last Basin Mixer', qty_received: 1, available_qty: available, transferable_qty: available, unit_price: 1000, stock_value: available * 1000 });
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: { lots: [lot()], brands: [], total_available_qty: available, total_stock_value: available * 1000, unpriced_lot_count: 0 } }));
  await page.route('**/api/customers', route => route.fulfill({ json: [{ id: 'client', name: 'Fixture Customer' }] }));
  await page.route('**/api/godown-stock/last-lot/po-final-matches', route => route.fulfill({ json: { matches: [], total_ordered_qty: 0, transferable_qty: 1 } }));
  await page.route('**/api/purchases/customer-workspace/client**', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/godown-stock/last-lot/customer-transfers', route => {
    expect(route.request().postDataJSON()).toMatchObject({ qty: 1, recipient_customer_id: 'client' });
    available = 0;
    return route.fulfill({ json: { id: 'transfer-last', stock_id: 'last-lot', sku: 'LAST-1', name: 'Last Basin Mixer', qty: 1, recipient_customer_id: 'client', recipient_customer_name: 'Fixture Customer', status: 'completed', transfer_type: 'godown_stock' } });
  });
  await page.goto('/godown-stock');
  await page.getByRole('button', { name: 'Transfer Last Basin Mixer to a customer' }).click();
  await page.getByTestId('godown-recipient-client').click();
  await page.getByTestId('godown-transfer-qty').fill('1');
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByRole('dialog', { name: 'Transfer stock to customer' })).toHaveCount(0);
  await expect(page.getByText('Last Basin Mixer', { exact: true })).toBeVisible();
  await expect(page.getByText('Out of stock · 0 units · ₹0 stock value', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Transfer Last Basin Mixer to a customer' })).toBeDisabled();
});

async function switchToGroundFloor(page: Page) {
  await page.getByTestId('floor-switcher').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Ground Floor', exact: true }).click();
  await expect(page).toHaveURL(/\/tiles$/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe('ground-floor');
}

test('critical a delayed stock transfer cannot reload its old floor after switching workspaces', async ({ page }) => {
  await mockSession(page, '/godown-stock');
  const lot = { id: 'delayed-lot', product_id: 'product', sku: 'DELAYED-1', name: 'Delayed Basin Mixer', qty_received: 1, available_qty: 1, transferable_qty: 1, unit_price: 1000, stock_value: 1000 };
  const requestedFloors: string[] = [];
  await page.route('**/api/godown-stock?**', route => {
    requestedFloors.push(route.request().headers()['x-floor-id']);
    return route.fulfill({ json: { lots: [lot], brands: [], total_available_qty: 1, total_stock_value: 1000, unpriced_lot_count: 0 } });
  });
  await page.route('**/api/customers', route => route.fulfill({ json: [{ id: 'client', name: 'Fixture Customer' }] }));
  await page.route('**/api/godown-stock/delayed-lot/po-final-matches', route => route.fulfill({ json: { matches: [], total_ordered_qty: 0, transferable_qty: 1 } }));
  let finishTransfer!: () => void;
  const transferGate = new Promise<void>(resolve => { finishTransfer = resolve; });
  await page.route('**/api/godown-stock/delayed-lot/customer-transfers', async route => {
    await transferGate;
    return route.fulfill({ json: { id: 'delayed-transfer', recipient_customer_name: 'Fixture Customer', status: 'completed' } });
  });
  await page.goto('/godown-stock');
  await page.getByRole('button', { name: 'Transfer Delayed Basin Mixer to a customer' }).click();
  await page.getByTestId('godown-recipient-client').click();
  const transferStarted = page.waitForRequest('**/api/godown-stock/delayed-lot/customer-transfers');
  await page.getByTestId('godown-customer-transfer-submit').click();
  await transferStarted;
  // Closing the sheet does not cancel the submitted mutation. Its eventual
  // completion must not start a reload under the abandoned stock floor.
  await page.getByRole('dialog', { name: 'Transfer stock to customer' }).getByRole('button', { name: 'Close', exact: true }).click();
  await switchToGroundFloor(page);
  const requestsBeforeCompletion = requestedFloors.length;
  finishTransfer();
  // The API client cancels transport when the workspace changes. The hook
  // regression separately exercises an already-resolved mutation callback.
  await page.waitForTimeout(300);
  expect(requestedFloors).toHaveLength(requestsBeforeCompletion);
  await expect(page.getByRole('dialog', { name: 'Transfer stock to customer' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/tiles$/);
});

for (const result of ['matches', 'error'] as const) {
  test(`critical delayed new-stock PO Final ${result} cannot affect a different workspace`, async ({ page }) => {
    await mockSession(page, '/godown-stock');
    const lot = { id: 'new-delayed-lot', product_id: 'product', sku: 'NEW-1', name: 'New Basin Mixer', qty_received: 1, available_qty: 1, transferable_qty: 1, stock_value: 1000 };
    await page.route('**/api/godown-stock?**', route => route.fulfill({ json: { lots: [lot], brands: [], total_available_qty: 1, total_stock_value: 1000, unpriced_lot_count: 0 } }));
    let finishMatches!: () => void;
    const matchGate = new Promise<void>(resolve => { finishMatches = resolve; });
    const endpoint = '**/api/godown-stock/new-delayed-lot/po-final-matches';
    await page.route(endpoint, async route => {
      await matchGate;
      return result === 'error'
        ? route.fulfill({ status: 400, json: { detail: 'Delayed old-floor PO match error' } })
        : route.fulfill({ json: { matches: [{ purchase_item_id: 'old-po', purchase_order_id: 'old-order', customer_id: 'client', customer_name: 'Old Floor Customer', ordered_qty: 1, remaining_qty: 1, name: lot.name, sku: lot.sku }], total_ordered_qty: 1, transferable_qty: 1 } });
    });
    const lookupStarted = page.waitForRequest(endpoint);
    await page.goto('/godown-stock?newStockId=new-delayed-lot');
    await lookupStarted;
    await switchToGroundFloor(page);
    finishMatches();
    // Allow the fulfilled promise and React's render to settle before checking
    // that neither a matching-order dialog nor a stale error toast appears.
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog', { name: 'Matching orders in PO Final' })).toHaveCount(0);
    await expect(page.getByText('Old Floor Customer', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Delayed old-floor PO match error', { exact: true })).toHaveCount(0);
    await expect(page.getByText('PO Final matches could not be checked', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/tiles$/);
  });
}
