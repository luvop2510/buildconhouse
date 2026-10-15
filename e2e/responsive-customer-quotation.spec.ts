import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical customer quotation rows and sanitary quotation detail stay aligned inside the viewport', async ({ page }) => {
  await mockSession(page, '/customers/mobile-customer', false);

  const quote = {
    id: 'mobile-quote', number: 'Q-2026-00421', customer_id: 'mobile-customer',
    customer_name: 'Mobile Buyer', created_by_name: 'Audit Owner', floor_id: 'first-floor',
    status: 'pending_approval', grand_total: 127500, subtotal: 135000, discount_total: 7500,
    created_at: '2026-10-10T10:00:00Z', rooms: ['Bathroom'],
    items: [{ id: 'line-one', sku: 'BASIN-1', name: 'Bathroom basin', qty: 1, unit_price: 135000, discount_pct: 5, room: 'Bathroom' }],
  };

  await page.route('**/api/customers/mobile-customer**', route => route.fulfill({ json: {
    id: 'mobile-customer', name: 'Mobile Buyer', company: 'Mobile Buyer', email: 'buyer@example.test',
    phone: '9909906652', city: 'Ahmedabad', purchase_completion_status: 'active',
  } }));
  await page.route('**/api/quotations?customer_id=mobile-customer', route => route.fulfill({ json: [quote] }));
  await page.route('**/api/activity/customer/mobile-customer', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?customer_id=mobile-customer', route => route.fulfill({ json: [] }));
  await page.route('**/api/godown-stock/customer-transfers?customer_id=mobile-customer', route => route.fulfill({ json: { transfers: [] } }));
  await page.route('**/api/purchases/customers/mobile-customer/workspace', route => route.fulfill({ json: {
    customer: { id: 'mobile-customer', name: 'Mobile Buyer' },
    summary: { total_items: 0, total_value: 0, outstanding_value: 0, outstanding_count: 0, open_pos: 0, blocked_count: 0, delivered_count: 0, shortage_count: 0 },
    shortages: [], products: [], brands: [], stages: [], purchase_orders: [], outstanding_items: [], recent_activity: [],
    expected_delivery: { next_at: null, purchase_orders: [] },
  } }));
  await page.route('**/api/quotations/mobile-quote/breakdown', route => route.fulfill({ json: {
    lines: [{ line_id: 'line-one', discount_pct: 5, discount_source: 'product', discount_amount: 7500, gross: 135000, net: 127500, total: 127500 }],
    totals: { subtotal: 135000, discount_total: 7500, grand_total: 127500 }, project_discount_pct: 0, category_discounts: {},
  } }));
  await page.route(/\/api\/quotations\/mobile-quote(?:\?.*)?$/, route => route.fulfill({ json: quote }));
  await page.route('**/api/activity/quotation/mobile-quote', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?quotation_id=mobile-quote', route => route.fulfill({ json: [] }));

  await page.goto('/customers/mobile-customer');
  await page.getByTestId('customer-tab-quotations').click();
  const row = page.getByTestId('customer-quotation-mobile-quote');
  await expect(row).toBeVisible();
  const rowBox = await row.boundingBox();
  if ((page.viewportSize()?.width ?? 0) < 700) expect(rowBox?.height).toBeGreaterThan(64);
  await expect(page.getByTestId('manage-quotation-products-mobile-quote')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  await row.click();
  const summaryTitle = page.getByRole('heading', { name: 'Mobile Buyer', exact: true });
  await expect(summaryTitle).toBeVisible();
  const summaryBox = await summaryTitle.boundingBox();
  expect(summaryBox?.x).toBeGreaterThanOrEqual(12);
  await expect(page.getByText('Bathroom basin', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

});
