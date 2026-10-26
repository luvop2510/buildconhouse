import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical godown transfer buttons keep equal height across varied product cards', async ({ page }, info) => {
  await mockSession(page, '/godown-stock', false);
  const lots = [
    { id: 'short', name: 'Basin', sku: 'B1', brand_name: 'Grohe' },
    { id: 'long', name: 'Long sanitary bathroom wall mounted thermostatic shower mixer with complete concealed parts', sku: 'VERY-LONG-SANITARY-SKU-2048', brand_name: 'Hansgrohe', reason: 'Customer returned unopened stock after changing the bathroom design and product specification' },
    { id: 'priced', name: 'Bath mixer with multiple finishes', sku: 'MIXER-3', brand_name: 'Duravit', price_variants: [{ label: 'Brushed bronze', price: 25000 }, { label: 'Polished chrome', price: 18000 }] },
  ].map(lot => ({ product_id: `godown:${lot.id}`, qty_received: 5, available_qty: 5, transferable_qty: 5,
    unit_price: 1000, stock_value: 5000, ...lot }));
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots, brands: [], total_lots: 3, available_lot_count: 3, unknown_quantity_count: 0, zero_lot_count: 0,
    total_available_qty: 15, total_stock_value: 15000, unpriced_lot_count: 0, next_offset: null,
  } }));
  await page.goto('/godown-stock');
  const heights: number[] = [];
  const cards: number[] = [];
  for (const lot of lots) {
    const card = page.getByTestId(`godown-lot-${lot.id}`);
    await expect(card).toBeAttached();
    const button = page.getByRole('button', { name: `Transfer ${lot.name} to a customer`, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    const cardBounds = await card.boundingBox();
    expect(bounds).not.toBeNull();
    heights.push(bounds!.height);
    cards.push(cardBounds!.height);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeLessThanOrEqual(49);
  }
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  await info.attach('transfer-button-dimensions', { body: JSON.stringify({ heights, cardHeights: cards }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('uniform-godown-transfer-buttons.png'), fullPage: true });
});

test('critical customer purchase Outstanding uses unpaid order balance instead of material cost', async ({ page }, info) => {
  await mockSession(page, '/customers/value-buyer', false);
  const customer = { id: 'value-buyer', name: 'Value Buyer', company: 'Value Buyer', email: 'buyer@example.test',
    purchase_completion_status: 'active' };
  let received = 0;
  await page.route('**/api/customers/value-buyer**', route => route.fulfill({ json: customer }));
  await page.route('**/api/quotations?customer_id=value-buyer', route => route.fulfill({ json: [] }));
  await page.route('**/api/activity/customer/value-buyer', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?customer_id=value-buyer', route => route.fulfill({ json: [] }));
  await page.route('**/api/godown-stock/customer-transfers?customer_id=value-buyer', route => route.fulfill({ json: { transfers: [] } }));
  await page.route('**/api/purchases/customers/value-buyer/workspace', route => route.fulfill({ json: {
    customer, summary: { total_items: 1, total_value: 743000, order_value: 782000,
      outstanding_value: 743000, outstanding_balance: 782000 - received, outstanding_count: 1,
      open_pos: 1, blocked_count: 0, delivered_count: 0, shortage_count: 0 },
    shortages: [], products: [], brands: [], stages: [], purchase_orders: [], outstanding_items: [], recent_activity: [],
    expected_delivery: { next_at: null, purchase_orders: [] },
  } }));
  const showPurchases = async () => {
    await page.goto('/customers/value-buyer');
    await page.getByTestId('customer-tab-purchases').click();
    await expect(page.getByRole('button', { name: 'Order Value: ₹7.82 L', exact: true })).toBeVisible();
  };
  await showPurchases();
  await expect(page.getByRole('button', { name: 'Outstanding: ₹7.82 L', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Outstanding: ₹7.43 L', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('unpaid-order-consistent-value.png'), fullPage: true });
  received = 39000;
  await showPurchases();
  await expect(page.getByRole('button', { name: 'Outstanding: ₹7.43 L', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('recorded-payment-reduces-balance.png'), fullPage: true });
});
