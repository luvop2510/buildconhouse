import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical customer shows commercial order value and PO Final on desktop and phone', async ({ page }, info) => {
  await mockSession(page, '/customers/c1');
  await page.route(/\/api\/customers\/c1(?:\?.*)?$/, route => route.fulfill({ json: {
    id: 'c1', name: '1 Vitra', email: 'vitra@example.test', tier: 'retail', phone: '9000000000',
  } }));
  await page.route('**/api/quotations', route => route.fulfill({ json: [{
    id: 'q1', customer_id: 'c1', number: 'Q-1', status: 'ordered', grand_total: 251128,
    created_at: '2026-09-01T10:00:00Z', items: [{ id: 'l1' }],
  }] }));
  await page.route('**/api/purchase-orders?customer_id=c1', route => route.fulfill({ json: [] }));
  await page.route('**/api/activity/customer/c1', route => route.fulfill({ json: [] }));
  await page.route('**/api/godown-stock/customer-transfers?customer_id=c1', route => route.fulfill({ json: { transfers: [] } }));
  await page.route('**/api/purchases/customers/c1/workspace**', route => route.fulfill({ json: {
    customer: { id: 'c1', name: '1 Vitra' },
    summary: { total_items: 1, total_value: 178064, order_value: 251128, outstanding_value: 0,
      outstanding_count: 0, open_pos: 1, blocked_count: 0, delivered_count: 1, shortage_count: 0 },
    shortages: [], products: [], outstanding_items: [], brands: [], stages: [],
    purchase_orders: [{ id: 'po1', number: 'PO-1', status: 'draft', brand_name: 'VitrA',
      grand_total: 251128, current_order_value: 251128, created_at: '2026-09-01T10:00:00Z', item_count: 1 }],
    recent_activity: [], expected_delivery: { next_at: null, purchase_orders: [] },
  } }));
  await page.route('**/api/customers/c1/po-final**', route => route.fulfill({ json: {
    customer: { id: 'c1', name: '1 Vitra' }, quotation_id: 'q1', quotation_number: 'Q-1', status: 'ordered',
    quotations: [{ id: 'q1', number: 'Q-1', status: 'ordered', grand_total: 251128 },
      { id: 'q2', number: 'Q-2', status: 'ordered', grand_total: 2 },
      { id: 'q3', number: 'Q-3', status: 'ordered', grand_total: 3 }],
    items: [{ id: 'l1', name: 'VitrA basin', sku: 'V-1', qty: 1, unit_price: 251128,
      total: 251128, source: 'purchase', stage: 'delivered' }],
    changes: [{ id: 'e1', at: '2026-09-02T10:00:00Z', type: 'purchase.borrowed_in',
      description: 'Borrowed product received from another customer' }],
    total: 251128, payment_extra_amount: 0, payable_total: 251128,
  } }));
  await page.route('**/api/customers/c1/po-final/xlsx?quotation_id=q1', route => route.fulfill({
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'PK-test-final-workbook',
  }));
  let releaseOlder!: () => void;
  const older = new Promise<void>(resolve => { releaseOlder = resolve; });
  let requestedOlder = false;
  await page.route('**/api/customers/c1/po-final?quotation_id=q2', async route => {
    requestedOlder = true;
    await older;
    await route.fulfill({ json: { customer: { id: 'c1', name: '1 Vitra' }, quotation_id: 'q2', quotation_number: 'Q-2',
      quotations: [], items: [], changes: [], total: 2, payable_total: 2, payment_extra_amount: 0 } });
  });
  await page.route('**/api/customers/c1/po-final?quotation_id=q3', route => route.fulfill({ json: {
    customer: { id: 'c1', name: '1 Vitra' }, quotation_id: 'q3', quotation_number: 'Q-3',
    quotations: [], items: [{ id: 'l3', name: 'Latest selected product', qty: 1, unit_price: 3, total: 3 }],
    changes: [], total: 3, payable_total: 3, payment_extra_amount: 0,
  } }));
  await page.goto('/customers/c1');
  await page.getByTestId('customer-tab-purchases').click();
  await expect(page.getByText('Order Value')).toBeVisible();
  await expect(page.getByText('₹2.51 L')).toBeVisible();
  await page.getByRole('button', { name: /^Open POs/ }).click();
  const orders = page.getByRole('dialog', { name: 'Open purchase orders' });
  const orderButton = orders.getByRole('button', { name: /^PO-1/ });
  const panel = await orders.boundingBox();
  const button = await orderButton.boundingBox();
  expect(button!.x - panel!.x, 'Customer order picker has a safe inner gutter').toBeGreaterThanOrEqual(16);
  await orders.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('customer-tab-po_final').click();
  await expect(page.getByTestId('customer-po-final')).toContainText('VitrA basin');
  await expect(page.getByTestId('customer-po-final')).toContainText('Borrowed product received');
  await expect(page.getByTestId('po-final-download')).toBeVisible();
  await expect(page.getByTestId('po-final-download-excel')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('po-final-download-excel').click();
  if (await page.evaluate(() => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent))) {
    await expect(page.getByTestId('mobile-file-save')).toBeVisible();
    await page.getByTestId('mobile-file-download').click();
  }
  expect((await downloaded).suggestedFilename()).toBe('1 Vitra PO Final Q-1.xlsx');
  await page.getByTestId('po-final-quotation-q2').click();
  await expect.poll(() => requestedOlder).toBe(true);
  await page.getByTestId('po-final-quotation-q3').click();
  await expect(page.getByTestId('customer-po-final')).toContainText('Latest selected product');
  releaseOlder();
  await expect(page.getByTestId('customer-po-final')).toContainText('Final amount · Q-3');
  await expect(page.getByTestId('po-final-download-excel')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('po-final.png'), fullPage: true });
});
