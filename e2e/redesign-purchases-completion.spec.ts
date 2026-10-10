import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const stages = ['po_final', 'order_in_company', 'company_billing', 'in_box', 'dispatched'].map(key => ({ key, label: ({ po_final: 'PO Final', order_in_company: 'Order in Company', company_billing: 'Company Billing', in_box: 'Inbox', dispatched: 'Dispatched' } as Record<string, string>)[key], count: 1, tone: { bg: '#eeeeee', fg: '#222222' } }));
const product = { item_id: 'i1', po_id: 'p1', po_number: 'PO-10', product_id: 'prod1', sku: 'F-10', name: 'Furniture chair', customer_id: 'c1', customer_name: 'RDCL', brand_id: 'brand1', brand_name: 'Chair company', stage: 'dispatched', stage_label: 'Dispatched', stage_tone: { bg: '#eeeeee', fg: '#222222' }, qty: 2, unit_cost: 125, last_moved_at: '2026-10-10T06:00:00Z', delivered_at: '2026-10-10T06:00:00Z', age_days: 0, blocked: false, sla_days: 7 };

 test('critical completed Purchases customers opens the shared product workspace with delivery details', async ({ page }, info) => {
  await mockSession(page, '/purchases-completed', false);
  await page.route('**/api/purchases/customers/completed?**', route => route.fulfill({ json: [{ id: 'c1', name: 'RDCL', count: 1, quantity: 2, completed_at: product.delivered_at }] }));
  await page.route('**/api/purchases/customers/c1/workspace', route => route.fulfill({ json: { customer: { id: 'c1', name: 'RDCL', phone: '9909906652' }, summary: { total_items: 1, total_value: 250, outstanding_value: 0, outstanding_count: 0, open_pos: 0, blocked_count: 0, delivered_count: 1, shortage_count: 0 }, outstanding_items: [], products: [product] } }));
  await page.route('**/api/purchases/items/page?**', route => route.fulfill({ json: { items: [product], total: 1, next_skip: null, has_more: false, summaries: { sla_days: 7, blocked_count: 0, stage_counts: { dispatched: 1 } } } }));
  await page.goto('/purchases-completed');
  await page.getByTestId('customer-workspace-c1').click();
  await expect(page.getByText('Delivered products · 100% complete', { exact: true })).toBeVisible();
  await expect(page.getByText('Furniture chair', { exact: true })).toBeVisible();
  await expect(page.getByText(/PO-10 · Chair company/)).toBeVisible();
  await expect(page.getByText(/Delivered 10 Oct/)).toBeVisible();
  expect(page.url()).toContain('/purchases-completed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('completed-purchases.png'), animations: 'disabled' });
});

 test('critical stock Customer Name filter requests customer scope and shows five final stages', async ({ page }) => {
  await mockSession(page, '/purchases', false);
  await page.route('**/api/purchases/customer-workspaces?**', route => route.fulfill({ json: [{ id: 'c1', name: 'RDCL' }, { id: 'c2', name: 'Other Buyer' }] }));
  await page.route('**/api/purchases/stages', route => route.fulfill({ json: stages }));
  await page.route('**/api/purchases/brands', route => route.fulfill({ json: { all: 5, brands: [] } }));
  await page.route('**/api/purchases/shortages?**', route => route.fulfill({ json: { items: [] } }));
  let scoped = false;
  await page.route('**/api/purchases/items/page?**', route => { scoped ||= new URL(route.request().url()).searchParams.get('customer') === 'c1'; return route.fulfill({ json: { items: [product], total: 1, next_skip: null, has_more: false, summaries: { sla_days: 7, blocked_count: 0, stage_counts: { dispatched: 1 } } } }); });
  await page.goto('/purchases');
  await page.getByTestId('view-stock').click();
  if (page.viewportSize()!.width < 1366) {
    await page.getByTestId('purchases-filter-button').click();
    await page.getByRole('button', { name: 'RDCL', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Order in Company (0)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^In Transit/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Delivered \(/ })).toHaveCount(0);
    await page.getByTestId('apply-purchase-filters').click();
  } else {
    await page.getByRole('button', { name: 'Filter stock for RDCL', exact: true }).click();
    await expect(page.getByText('Order in Company', { exact: true })).toBeVisible();
  }
  await expect.poll(() => scoped).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
