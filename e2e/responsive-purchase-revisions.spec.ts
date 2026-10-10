import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const stages = [
  { key: 'po_final', label: 'PO final', count: 0, tone: 'neutral' },
  { key: 'order_in_company', label: 'Order in company', count: 1, tone: 'warning' },
  { key: 'company_billing', label: 'Company billing', count: 0, tone: 'neutral' },
  { key: 'in_box', label: 'Inbox', count: 1, tone: 'neutral' },
  { key: 'dispatched', label: 'Dispatched', count: 0, tone: 'success' },
];
const item = { item_id: 'item1', po_id: 'po1', po_number: 'PO-1', po_status: 'open',
  name: 'Furniture chair', sku: 'FC-1', customer_id: 'client1', customer_name: 'Mira Shah',
  brand_id: 'brand1', brand_name: 'Example Company', qty: 2, unit_cost: 100, stage: 'in_box', stage_label: 'Inbox',
  age_days: 2, blocked: false, stage_history: [], room: 'Living room', floor_id: 'first-floor' };

test('order movement excludes quantities already returned from customer stock', async ({ page }) => {
  await mockSession(page, '/purchase-orders/po1', false);
  await page.route('**/api/purchases/stages', route => route.fulfill({ json: stages }));
  await page.route('**/api/purchases/po1/order-detail', route => route.fulfill({ json: {
    id: 'po1', number: 'PO-1', customer_id: 'client1', customer_name: 'Mira Shah',
    floor_id: 'first-floor', status: 'ordered', brand_name: 'Example Company',
    status_history: [], attachments: [], stage: 'order', remaining_qty_by_item: {},
    subtotal: 1000, grand_total: 1000, created_at: '2026-10-10T10:00:00Z', created_by_name: 'Audit Owner',
    items: [{ id: 'item1', product_id: 'p1', name: 'Furniture chair', sku: 'FC-1',
      qty: 10, godown_transferred_qty: 2, loan_replenishment_returned_qty: 1,
      qty_received: 10, unit_cost: 100, stage: 'in_box' }], chalans: [],
  } }));
  await page.goto('/purchase-orders/po1');
  await page.getByTestId('po-item-move-item1').click();
  await expect(page.getByTestId('movement-qty')).toHaveValue('7');
  await expect(page.getByText('of 7 available', { exact: true })).toBeVisible();
});

test('stock customer filter composes with stages and displays scoped stage counts', async ({ page }) => {
  await mockSession(page, '/purchases', false);
  await page.route('**/api/purchases/brands', route => route.fulfill({ json: { brands: [{ id: 'brand1', name: 'Example Company', count: 2 }], all: 2 } }));
  await page.route('**/api/purchases/stages', route => route.fulfill({ json: stages }));
  await page.route('**/api/purchases/customer-workspaces?**', route => route.fulfill({ json: [{ id: 'client1', name: 'Mira Shah', count: 1 }] }));
  await page.route('**/api/purchases/shortages', route => route.fulfill({ json: [] }));
  const requests: URL[] = [];
  await page.route('**/api/purchases/items/page?**', route => {
    const url = new URL(route.request().url()); requests.push(url);
    return route.fulfill({ json: { items: [item], total: 1, next_skip: null, summaries: {
      blocked_count: 0, sla_days: 7, stage_counts: url.searchParams.has('customer') ? { in_box: 1 } : { in_box: 1, order_in_company: 1 },
    } } });
  });
  await page.goto('/purchases');
  await page.getByTestId('view-stock').click();
  const mobile = await page.getByTestId('purchases-filter-button').isVisible();
  if (mobile) {
    await page.getByTestId('purchases-filter-button').click();
    await page.getByRole('button', { name: 'Mira Shah', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Order in company (0)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Inbox (1)', exact: true }).click();
    await page.getByTestId('apply-purchase-filters').click();
  } else {
    await page.getByRole('button', { name: 'Filter stock for Mira Shah', exact: true }).click();
    await page.getByText('Inbox', { exact: true }).first().click();
  }
  await expect.poll(() => requests.some(url => url.searchParams.get('customer') === 'client1' && url.searchParams.get('stage') === 'in_box')).toBe(true);
  await expect(page.getByText('Furniture chair', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('In Transit', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('100 percent customers open Purchases workspace with delivery time and product details', async ({ page }, info) => {
  await mockSession(page, '/purchases-completed', false);
  const delivered = { ...item, stage: 'dispatched', stage_label: 'Dispatched', dispatched_at: '2026-10-09T10:00:00Z', delivered_at: '2026-10-09T10:00:00Z' };
  await page.route('**/api/purchases/customers/completed?**', route => route.fulfill({ json: [{ id: 'client1', name: 'Mira Shah', count: 1, quantity: 2, completed_at: delivered.delivered_at }] }));
  await page.route('**/api/purchases/customers/client1/workspace', route => route.fulfill({ json: {
    customer: { id: 'client1', name: 'Mira Shah', phone: '9909906652', company: 'RDCL' },
    summary: { total_items: 1, delivered_count: 1, outstanding_balance: 0, outstanding_count: 0, open_pos: 0, blocked_count: 0, outstanding_value: 0 }, products: [delivered],
  } }));
  await page.route('**/api/purchases/items/page?**', route => route.fulfill({ json: { items: [delivered], total: 1, next_skip: null, summaries: { blocked_count: 0, sla_days: 7, stage_counts: { dispatched: 1 } } } }));
  await page.goto('/purchases-completed');
  await page.getByTestId('customer-workspace-client1').click();
  await expect(page.getByText('Delivered products · 100% complete', { exact: true })).toBeVisible();
  await expect(page.getByText('Furniture chair', { exact: true })).toBeVisible();
  await expect(page.getByText(/PO-1 · Example Company/)).toBeVisible();
  await expect(page.getByText(/Delivered 9 Oct/)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/purchases-completed');
  await expect(page.getByRole('button', { name: 'Move Furniture chair', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('completed-purchases.png'), fullPage: true });
});

for (const choice of ['keep', 'latest'] as const) {
  test(`draft purchase order price change requires explicit ${choice} choice`, async ({ page }) => {
    await mockSession(page, '/quotations/review1/place-order', false);
    await page.route('**/api/suppliers', route => route.fulfill({ json: [{ id: 'supplier1', name: 'Example Company', brand_id: 'brand1' }] }));
    await page.route('**/api/quotations/review1/place-order/preview', route => route.fulfill({ json: {
      quotation_id: 'review1', quotation_number: 'Q-1', doc_type: 'standard', customer_id: 'client1', customer_name: 'Mira Shah', total_value: 100,
      brands: [{ brand_id: 'brand1', brand_name: 'Example Company', item_count: 1, subtotal: 100, default_supplier: { id: 'supplier1', name: 'Example Company' },
        items: [{ line_id: 'line1', name: 'Furniture chair', sku: 'FC-1', qty: 1, unit_cost: 100 }] }],
      price_review: { token: 'review-token', changes: [{ line_id: 'line1', name: 'Furniture chair', sku: 'FC-1', old_unit_price: 100, new_unit_price: 125 }] },
    } }));
    let submitted: any = null;
    await page.route('**/api/quotations/review1/place-order/confirm', route => {
      submitted = route.request().postDataJSON();
      return route.fulfill({ status: 503, json: { detail: 'Synthetic PO save outage' } });
    });
    await page.goto('/quotations/review1/place-order');
    await page.getByTestId('confirm-place-order').click();
    await expect(page.getByText('Company prices have changed', { exact: true })).toBeVisible();
    expect(submitted).toBeNull();
    await page.getByTestId(choice === 'keep' ? 'keep-original-prices' : 'apply-latest-prices').click();
    await expect.poll(() => submitted?.catalog_price_choice).toBe(choice);
    expect(submitted.catalog_price_token).toBe('review-token');
    await expect(page.getByText('Synthetic PO save outage', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
