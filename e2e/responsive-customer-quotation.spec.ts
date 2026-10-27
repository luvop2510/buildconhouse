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
  const width = page.viewportSize()?.width ?? 0;
  if (width < 700) {
    expect(rowBox?.height).toBeGreaterThan(64);
    expect(rowBox?.x).toBeGreaterThanOrEqual(12);
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(width - 12);
  }
  await expect(page.getByTestId('manage-quotation-products-mobile-quote')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  if (width <= 390) {
    await page.getByTestId('manage-quotation-products-mobile-quote').click();
    await page.getByRole('button', { name: /Review/ }).click();
    await expect(page.getByTestId('room-header-Bathroom')).toBeVisible();
    const roomHeader = await page.getByTestId('room-header-Bathroom').boundingBox();
    expect(roomHeader?.x).toBeGreaterThanOrEqual(12);
    expect(roomHeader!.x + roomHeader!.width).toBeLessThanOrEqual(width - 12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.goto('/customers/mobile-customer');
    await page.getByTestId('customer-tab-quotations').click();
  }

  await row.click();
  const summaryTitle = page.getByRole('heading', { name: 'Mobile Buyer', exact: true });
  await expect(summaryTitle).toBeVisible();
  const summaryBox = await summaryTitle.boundingBox();
  expect(summaryBox?.x).toBeGreaterThanOrEqual(12);
  await expect(page.getByText('Bathroom basin', { exact: true })).toBeVisible();
  if (width < 700) {
    for (const selector of ['[data-testid="quotation-detail-summary"]', '[data-testid="quotation-line-line-one"]', '[data-testid="quotation-detail-totals"]']) {
      const box = await page.locator(selector).boundingBox();
      expect(box, `${selector} should have measurable mobile geometry`).not.toBeNull();
      expect(box!.x, `${selector} should have a left gutter`).toBeGreaterThanOrEqual(16);
      expect(box!.x + box!.width, `${selector} should have a right gutter`).toBeLessThanOrEqual(width - 16);
    }
    const itemText = await page.getByText('Bathroom basin', { exact: true }).boundingBox();
    expect(itemText?.x).toBeGreaterThanOrEqual(24);
    expect(itemText!.x + itemText!.width).toBeLessThanOrEqual(width - 24);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

});


for (const floorId of ['first-floor', 'ground-floor']) test(`critical ${floorId} customer only offers its supported document stages`, async ({ page }) => {
  await mockSession(page, '/customers/stage-customer', false, { floorId });
  await page.route('**/api/customers/stage-customer**', route => route.fulfill({ json: {
    id: 'stage-customer', name: 'Stage Customer', phone: '9000000000', purchase_completion_status: 'active',
  } }));
  await page.route('**/api/quotations?customer_id=stage-customer', route => route.fulfill({ json: [] }));
  await page.route('**/api/activity/customer/stage-customer', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?customer_id=stage-customer', route => route.fulfill({ json: [] }));
  await page.route('**/api/godown-stock/customer-transfers?customer_id=stage-customer', route => route.fulfill({ json: { transfers: [] } }));
  await page.goto('/customers/stage-customer');
  await expect(page.getByRole('heading', { name: 'Stage Customer', exact: true })).toBeVisible();
  await expect(page.getByTestId('customer-tab-po_final')).toHaveCount(floorId === 'first-floor' ? 1 : 0);
  if (floorId === 'ground-floor') {
    await expect(page.getByTestId('customer-tab-purchases')).toHaveCount(0);
    await expect(page.getByTestId('customer-ground-floor-tile-orders')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(3);
  }
});
