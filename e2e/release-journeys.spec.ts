import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const followup = (id: string, name: string) => ({
  id, customer_id: id, customer_name: name, customer_tier: 'retail', customer_phone: '9000000000',
  rule_type: 'manual', category: 'general', value: 12000, reason: 'Confirm the delivery date', reason_factors: [],
  next_action: 'Call customer', next_action_reason: 'Delivery confirmation', suggested_channel: 'call',
  priority_score: 70, priority_level: 'high', due_at: new Date().toISOString(), status: 'open',
  is_automated: false, auto_resolved: false, contact_attempts: 0, tags: [], bucket: 'today',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), assigned_to: 'audit-owner',
});

async function followupsSession(page: Page) {
  await mockSession(page, '/followups');
  await page.route('**/api/followups/config/assignees', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  await page.route('**/api/customers', route => route.fulfill({ json: [] }));
  // Optional summaries intentionally fail. The primary task queue must remain usable.
}

test('critical GoDown transfer records quantity, price, discount and PO Final replacement on phone and tablet', async ({ page }, info) => {
  await mockSession(page, '/godown-stock');
  const lot = { id: 'lot-1', product_id: 'product-1', sku: 'ABC-1', name: 'Basin mixer', brand_name: 'Brand', qty_received: 5, available_qty: 5, transferable_qty: 5, unit_price: 1000, stock_value: 5000, created_at: '2026-09-20T10:00:00Z' };
  const match = { purchase_item_id: 'po-item-1', purchase_order_id: 'po-1', customer_id: 'customer-1', customer_name: 'Asha Customer', ordered_qty: 3, remaining_qty: 3, product_id: 'product-1', sku: 'ABC-1', name: 'Basin mixer' };
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: { lots: [lot], brands: [], total_available_qty: 5, total_stock_value: 5000, unpriced_lot_count: 0 } }));
  await page.route('**/api/godown-stock/lot-1/po-final-matches', route => route.fulfill({ json: { matches: [match], total_ordered_qty: 3, transferable_qty: 5 } }));
  await page.route('**/api/customers', route => route.fulfill({ json: [{ id: 'customer-1', name: 'Asha Customer' }] }));
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/godown-stock/lot-1/customer-transfers', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { id: 'transfer-1', stock_id: 'lot-1', sku: 'ABC-1', name: 'Basin mixer', qty: 2, recipient_customer_id: 'customer-1', recipient_customer_name: 'Asha Customer', status: 'completed', transfer_type: 'godown_stock', unit_price: 1000, mrp: 1000, discount_pct: 10, net_unit_price: 900, total: 1800 } });
  });
  await page.goto('/godown-stock');
  await page.getByRole('button', { name: 'Transfer Basin mixer to a customer' }).click();
  await page.getByTestId('godown-recipient-customer-1').click();
  await page.getByText('Basin mixer · 3 waiting').click();
  await page.getByTestId('godown-transfer-qty').fill('2');
  await page.getByTestId('godown-transfer-price').fill('1000');
  await page.getByTestId('godown-transfer-discount').fill('10');
  await expect(page.getByTestId('godown-transfer-total')).toContainText('1,800');
  await expect(page.getByText(/This permanently moves stock/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(`godown-transfer-${info.project.name}.png`) });
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toMatchObject({ qty: 2, recipient_customer_id: 'customer-1', recipient_purchase_item_id: 'po-item-1', unit_price: 1000, discount_pct: 10 });
});

test('critical Follow-ups optional failure preserves queue and server search finds distant records', async ({ page }, info) => {
  await followupsSession(page);
  const requests: string[] = [];
  await page.route('**/api/followups/page?**', route => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    const searched = url.searchParams.get('q') === 'Customer 1201';
    return route.fulfill({ json: { items: [followup(searched ? '1201' : '1', searched ? 'Customer 1201' : 'First Customer')], page: 1, page_size: 100, has_more: false } });
  });
  await page.goto('/followups');
  await expect(page.getByTestId('followup-1')).toBeVisible();
  await expect(page.getByText('Follow-ups are unavailable', { exact: true })).toHaveCount(0);
  await page.getByTestId('followups-search').fill('Customer 1201');
  await expect(page.getByTestId('followup-1201')).toBeVisible();
  await expect(page.getByTestId('followup-1')).toHaveCount(0);
  expect(requests.some(query => new URLSearchParams(query).get('q') === 'Customer 1201')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('followups-populated.png'), fullPage: true });
});

test('critical Follow-ups bulk partial failure retains failed records and retries only failures', async ({ page }) => {
  await followupsSession(page);
  await page.route('**/api/followups/page?**', route => route.fulfill({ json: {
    items: [followup('one', 'Asha Customer'), followup('two', 'Bharat Customer')], page: 1, page_size: 100, has_more: false,
  } }));
  const mutations: string[] = [];
  await page.route('**/api/followups/*/complete', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    mutations.push(id);
    return id === 'two' && mutations.filter(value => value === id).length === 1
      ? route.fulfill({ status: 409, json: { detail: 'Record changed. Retry.' } })
      : route.fulfill({ json: { ok: true } });
  });
  await page.goto('/followups');
  await page.getByTestId('followup-one').getByLabel('Select', { exact: true }).click();
  await page.getByTestId('followup-two').getByLabel('Select', { exact: true }).click();
  await page.getByRole('button', { name: 'Complete', exact: true }).first().click();
  await expect(page.getByText('1 updated, 1 failed', { exact: true })).toBeVisible();
  expect(mutations.sort()).toEqual(['one', 'two']);
  await page.getByRole('button', { name: 'Retry failed', exact: true }).click();
  await expect.poll(() => mutations.length).toBe(3);
  expect(mutations.filter(id => id === 'one')).toHaveLength(1);
  expect(mutations.filter(id => id === 'two')).toHaveLength(2);
  await expect(page.getByRole('button', { name: 'Retry failed', exact: true })).toHaveCount(0);
});

test('critical Follow-ups failed queue shows recovery and page navigation bounds mounted records', async ({ page }) => {
  await followupsSession(page);
  let fail = true;
  await page.route('**/api/followups/page?**', route => {
    if (fail) return route.fulfill({ status: 503, json: { detail: 'Queue temporarily unavailable' } });
    const number = Number(new URL(route.request().url()).searchParams.get('page'));
    return route.fulfill({ json: { items: [followup(`page-${number}`, `Page ${number} Customer`)], page: number, page_size: 100, has_more: number < 3 } });
  });
  await page.goto('/followups');
  await expect(page.getByText('Follow-ups are unavailable', { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('followup-page-1')).toBeVisible();
  await page.getByTestId('followups-next-page').click();
  await expect(page.getByTestId('followup-page-2')).toBeVisible();
  await expect(page.getByTestId('followup-page-1')).toHaveCount(0);
  await page.getByTestId('followups-previous-page').click();
  await expect(page.getByTestId('followup-page-1')).toBeVisible();
  await expect(page.getByTestId('followup-page-2')).toHaveCount(0);
});

test('critical Tile Orders bounded pages preserve quantities and search resets paging', async ({ page }, info) => {
  await mockSession(page, '/tiles/orders');
  const requests: URL[] = [];
  await page.route('**/api/tile-orders/customer-orders?**', route => {
    const url = new URL(route.request().url()); requests.push(url);
    const number = Number(url.searchParams.get('page') || 1);
    const name = url.searchParams.get('search') ? 'Matched Customer' : `Customer Page ${number}`;
    return route.fulfill({ json: { orders: [{
      id: `order-${number}`, number: `TCO-00${number}`, customer_name: name, customer_phone: '9000000000',
      order_date: '2026-09-08T12:00:00Z', waiting_days: 2, ageing_band: 'green', brands: [],
      total_products: 3, total_boxes: 24, total_value: 48000, overall_status: 'Partially Dispatched', completion_percentage: 50,
    }], page: number, page_size: 30, total: 61, has_more: number < 3, next_page: number < 3 ? number + 1 : null } });
  });
  await page.goto('/tiles/orders');
  await expect(page.getByText('Customer Page 1', { exact: true })).toBeVisible();
  await page.getByTestId('tile-orders-load-more').click();
  await expect(page.getByText('Customer Page 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Customer Page 1', { exact: true })).toHaveCount(0);
  await page.getByTestId('tile-orders-previous-page').click();
  await expect(page.getByText('Customer Page 1', { exact: true })).toBeVisible();
  await page.getByTestId('tile-orders-customer-search').fill('Matched');
  await expect(page.getByText('Matched Customer', { exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get('page')).toBe('1');
  expect(requests.at(-1)?.searchParams.get('search')).toBe('Matched');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('tile-orders-populated.png'), fullPage: true });
});

test('critical Tile Orders uses a compact mobile record instead of a desktop column dump', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSession(page, '/tiles/orders');
  await page.route('**/api/tile-orders/customer-orders?**', route => route.fulfill({ json: { orders: [{
    id: 'mobile-order', number: 'TCO-MOBILE', customer_name: 'Mobile Customer', customer_phone: '9000000000',
    order_date: '2026-09-08T12:00:00Z', waiting_days: 4, ageing_band: 'amber', brands: [{ brand_name: 'Example Tile Brand' }],
    total_products: 3, total_boxes: 24, total_value: 48000, overall_status: 'Partially Dispatched', completion_percentage: 50,
  }], page: 1, page_size: 30, total: 1, has_more: false, next_page: null } }));
  await page.goto('/tiles/orders');
  const record = page.getByTestId('tile-orders-customer-mobile-order');
  await expect(record).toBeVisible();
  await expect(record.getByText('Mobile Customer', { exact: true })).toBeVisible();
  await expect(record.getByText('ORDER NO.', { exact: true })).toBeVisible();
  await expect(record.getByText('STATUS', { exact: true })).toBeVisible();
  await expect(record.getByText('BRANDS', { exact: true })).toHaveCount(0);
  await expect(record.getByText('WAITING', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('tile-orders-tab-customer')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical Purchase Order remains usable when optional timeline configuration is unavailable', async ({ page }) => {
  await mockSession(page, '/purchase-orders/po-one');
  await page.route('**/api/purchases/po-one/order-detail', route => route.fulfill({ json: {
    id: 'po-one', number: 'PO-ONE', customer_id: 'customer-one', customer_name: 'Resilient Customer',
    status: 'draft', items: [], status_history: [], attachments: [], internal_notes: null,
    subtotal: 0, grand_total: 0, created_at: '2026-09-08T12:00:00Z', created_by_name: 'Audit Owner',
    stage: 'order', chalans: [], remaining_qty_by_item: {},
  } }));
  // The fixture's generic API route leaves config and activity requests at 503.
  await page.goto('/purchase-orders/po-one');
  await expect(page.getByText('PO-ONE', { exact: true })).toBeVisible();
  await expect(page.getByText('Resilient Customer', { exact: true })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByText('Could not load purchase order', { exact: true })).toHaveCount(0);
});
