import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const order = {
  id: 'payment-order', number: 'Q-PAY-1', customer_id: 'payment-client', customer_name: 'Payment Client',
  grand_total: 1200.5, paid: 0, outstanding: 1200.5, percent_collected: 0,
  payment_status: 'due', confirmed_at: '2026-09-01T12:00:00Z', days_unpaid: 3,
};
function detail(row = order) {
  return { ...row, status: 'ordered', customer: { id: row.customer_id, name: row.customer_name },
    floor_id: 'first-floor', mrp: 1200.5, discounted_rate: 1200.5, quotation_total: 1200.5,
    manual_extra_amount: 0, manual_extra_name: null, payments: [] };
}
async function collections(page: Page) {
  await mockSession(page, '/payments');
  await page.route('**/api/payments/stats', route => route.fulfill({ json: {
    earned_total: 0, total_outstanding: 1200.5, spending_total: 0, active_total: 1200.5,
    active_received: 0, active_orders: 1, fully_paid: 0, collected_this_month: 0,
  } }));
  await page.route('**/api/payments/orders', route => route.fulfill({ json: [order] }));
  await page.route('**/api/payments/orders/payment-order', route => route.fulfill({ json: detail() }));
  await page.goto('/payments');
  await page.getByTestId('open-record-payment').click();
}

test('critical payment overview collapses without losing a payment draft on rotation', async ({ page }, info) => {
  await collections(page);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const toggle = page.getByTestId('payments-page-details-toggle');
  const overview = page.getByTestId('payments-page-details');
  const phone = (page.viewportSize()?.width || 0) < 768;
  await expect(toggle).toHaveAttribute('aria-expanded', String(!phone));
  if (phone) await toggle.click();
  await expect(overview).toBeVisible();
  await expect(page.getByTestId('fully-paid-orders-link')).toBeVisible();
  const expandedTabsTop = (await page.getByTestId('payments-tabs').boundingBox())!.y;
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(overview).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  const collapsedTabsTop = (await page.getByTestId('payments-tabs').boundingBox())!.y;
  expect(expandedTabsTop - collapsedTabsTop).toBeGreaterThan(60);
  // Essential navigation and selected-order identity stay available in compact view.
  await expect(page.getByTestId('payments-tabs-collections')).toBeVisible();
  await expect(page.getByTestId('payments-order-detail')).toContainText('Payment Client');
  await page.getByTestId('payment-edit-quotation').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('payment-edit-quotation')).toBeInViewport();
  await page.getByTestId('open-record-payment').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('open-record-payment')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('payments-compact-overview.png') });
  await page.getByTestId('open-record-payment').click();
  await page.getByTestId('pay-amount').fill('600.25');
  await page.getByTestId('pay-mode-upi').click();
  await page.getByTestId('pay-reference').fill('Draft preserved on rotation');
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.height, height: viewport.width });
  await expect(page.getByTestId('pay-amount')).toHaveValue('600.25');
  await expect(page.getByTestId('pay-reference')).toHaveValue('Draft preserved on rotation');
  await expect(page.getByTestId('save-payment')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('payments-draft-rotated.png') });
  await page.setViewportSize(viewport);
  const writes: any[] = [];
  await page.route('**/api/payments', route => {
    writes.push({ payload: route.request().postDataJSON(), floor: route.request().headers()['x-floor-id'] });
    return route.fulfill({ status: 503, json: { detail: 'Keep this draft for retry' } });
  });
  await page.getByTestId('save-payment').click();
  await expect(page.getByTestId('record-payment-sheet').getByRole('alert')).toContainText('Keep this draft for retry');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ payload: { quotation_id: order.id, amount: 600.25, mode: 'upi', reference: 'Draft preserved on rotation' }, floor: 'first-floor' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('critical payment form keeps paise, validates overpayment, scrolls and retries with the same key', async ({ page }) => {
  await collections(page);
  await expect(page.getByTestId('pay-amount')).toHaveValue('1200.50');
  await expect(page.getByTestId('save-payment')).toBeInViewport();
  const writes: any[] = [];
  await page.route('**/api/payments', route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { detail: 'Receipt response unavailable' } });
  });
  for (const invalid of ['-100', '1e3', '12.345']) {
    await page.getByTestId('pay-amount').fill(invalid);
    await page.getByTestId('save-payment').click();
    await expect(page.getByTestId('record-payment-sheet').getByRole('alert')).toContainText('at most two decimal places');
    await expect(page.getByTestId('pay-amount')).toHaveValue(invalid);
  }
  await page.getByTestId('pay-amount').fill('1201');
  await page.getByTestId('save-payment').click();
  await expect(page.getByTestId('record-payment-sheet').getByRole('alert')).toContainText('cannot exceed');
  expect(writes).toHaveLength(0);
  await page.getByTestId('pay-amount').fill('600.25');
  await page.getByTestId('pay-reference').scrollIntoViewIfNeeded();
  await page.getByTestId('pay-reference').fill('UTR-PAISE');
  await expect(page.getByTestId('save-payment')).toBeInViewport();
  await page.getByTestId('save-payment').click();
  await expect(page.getByTestId('record-payment-sheet').getByRole('alert')).toContainText('Receipt response unavailable');
  // A failed save unlocks the sheet without exposing the background ledger to assistive technology.
  await expect(page.getByRole('alert')).toHaveCount(1);
  await page.getByTestId('save-payment').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0]).toMatchObject({ amount: 600.25, reference: 'UTR-PAISE' });
  expect(writes[0].idempotency_key).toBeTruthy();
  expect(writes[1].idempotency_key).toBe(writes[0].idempotency_key);
  await expect(page.getByTestId('pay-amount')).toHaveValue('600.25');
  await expect(page.getByTestId('pay-reference')).toHaveValue('UTR-PAISE');
});

test('critical successful payment removes the settled order and shows the next customer', async ({ page }) => {
  await collections(page);
  const next = { ...order, id: 'next-order', number: 'Q-PAY-2', customer_id: 'next-client', customer_name: 'Next Client' };
  await page.route('**/api/payments/orders', route => route.fulfill({ json: [next] }));
  await page.route('**/api/payments/orders/next-order', route => route.fulfill({ json: detail(next) }));
  let writes = 0;
  await page.route('**/api/payments', route => {
    writes++;
    return route.fulfill({ json: { id: 'paid-receipt', ...route.request().postDataJSON() } });
  });
  await page.getByTestId('save-payment').click();
  await expect(page.getByTestId('record-payment-sheet')).toHaveCount(0);
  await expect(page.getByTestId('payments-order-detail')).toContainText('Next Client');
  await expect(page.getByTestId('payments-order-detail')).toContainText('Q-PAY-2');
  expect(writes).toBe(1);
});

test('critical payment ledger reloads page one after Previous and ignores stale filter responses', async ({ page }) => {
  await mockSession(page, '/payments');
  let requestedOld = false;
  await page.route('**/api/payments/history?**', async route => {
    const params = new URL(route.request().url()).searchParams;
    const query = params.get('q');
    const skip = Number(params.get('skip'));
    if (query === 'old') {
      requestedOld = true;
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    const customer = query ? `${query} customer` : skip ? 'Page two customer' : 'Page one customer';
    return route.fulfill({ json: { total: query ? 1 : 51, items: [{
      id: `receipt-${query || skip}`, customer_id: 'payment-client', customer_name: customer,
      invoice_number: 'Q-PAY-1', floor_id: 'first-floor', business_unit: 'Sanitary',
      amount: 600.25, mode: 'cash', status: 'completed', paid_at: '2026-09-01T12:00:00Z',
      outstanding_before: 1200.5, outstanding_after: 600.25,
    }] } });
  });
  await page.goto('/payments');
  await page.getByTestId('payments-tabs-history').click();
  await expect(page.getByTestId('payment-history-table')).toContainText('Page one customer');
  await page.getByTestId('history-next-page').click();
  await expect(page.getByTestId('payment-history-table')).toContainText('Page two customer');
  await page.getByTestId('history-prev-page').click();
  await expect(page.getByTestId('payment-history-table')).toContainText('Page one customer');
  await page.getByTestId('history-search').fill('old');
  await expect.poll(() => requestedOld).toBe(true);
  await page.getByTestId('history-search').fill('new');
  await expect(page.getByTestId('payment-history-table')).toContainText('new customer');
  await page.waitForTimeout(850);
  await expect(page.getByTestId('payment-history-table')).toContainText('new customer');
  await expect(page.getByTestId('payment-history-table')).not.toContainText('old customer');
});


test('critical long payment ledger scrolls to the last receipt and keeps customer switching usable', async ({ page }, info) => {
  await mockSession(page, '/payments');
  const orders = Array.from({ length: 25 }, (_, i) => ({ ...order, id: `long-order-${i}`, customer_id: `long-client-${i}`, customer_name: `Long Client ${i}` }));
  let listRequests = 0;
  await page.route('**/api/payments/orders', route => { listRequests++; return route.fulfill({ json: orders }); });
  await page.route('**/api/payments/orders/long-order-*', route => {
    const row = orders.find(item => route.request().url().endsWith(`/orders/${item.id}`))!;
    return route.fulfill({ json: { ...detail(row), payments: Array.from({ length: 35 }, (_, i) => ({
      id: `receipt-${i}`, amount: 10.25, mode: 'cash', reference: `Receipt reference ${i}`,
      paid_at: '2026-09-01T12:00:00Z', recorded_by_name: 'Accounts',
    })) } });
  });
  await page.goto('/payments');
  if ((page.viewportSize()?.width || 0) < 768) await page.getByTestId('payments-mobile-customer-switch').click();
  const customer = page.getByTestId('payment-customer-long-client-24');
  await customer.scrollIntoViewIfNeeded();
  await customer.click();
  await expect(page.getByTestId('payments-order-detail')).toContainText('Long Client 24');
  const lastReceipt = page.getByText('Receipt reference 34', { exact: true });
  await lastReceipt.scrollIntoViewIfNeeded();
  await expect(lastReceipt).toBeInViewport();
  await page.screenshot({ path: info.outputPath('payments-long-history.png'), fullPage: false });
  await page.getByTestId('payment-cost-fields').scrollIntoViewIfNeeded();
  const panelBox = await page.getByTestId('payments-order-detail').boundingBox();
  expect(panelBox).toBeTruthy();
  for (const testId of ['ground-floor-manual-extra-name', 'ground-floor-manual-extra', 'save-ground-floor-manual-extra']) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.getByTestId('open-record-payment').scrollIntoViewIfNeeded();
  await page.getByTestId('open-record-payment').click();
  await expect(page.getByTestId('pay-amount')).toBeVisible();
  await expect(page.getByTestId('save-payment')).toBeInViewport();
  await page.getByTestId('pay-reference').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('pay-reference')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('payments-record-sheet.png'), fullPage: false });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('record-payment-sheet')).toHaveCount(0);
  expect(listRequests).toBe(1); // First focus must not race the initial search load.
});

test('critical customer collection separates total due from order value and switches quotations before recording', async ({ page }) => {
  await mockSession(page, '/payments');
  const rows = [
    { ...order, id: 'order-one', number: 'Q-ONE', grand_total: 500000, paid: 300000, outstanding: 200000 },
    { ...order, id: 'order-two', number: 'Q-TWO', grand_total: 400000, paid: 150000, outstanding: 250000 },
    { ...order, id: 'order-three', number: 'Q-THREE', grand_total: 277000, paid: 150000, outstanding: 127000 },
  ];
  await page.route('**/api/payments/stats', route => route.fulfill({ json: {
    earned_total: 600000, total_outstanding: 577000, spending_total: 0, active_total: 1177000,
    active_received: 600000, active_orders: 3, fully_paid: 0, collected_this_month: 0,
  } }));
  await page.route('**/api/payments/orders', route => route.fulfill({ json: rows }));
  await page.route('**/api/payments/orders/order-*', route => {
    const row = rows.find(item => route.request().url().endsWith(`/orders/${item.id}`))!;
    return route.fulfill({ json: { ...detail(row), quotation_total: row.grand_total } });
  });
  await page.goto('/payments');
  if ((page.viewportSize()?.width || 0) < 768) await page.getByRole('button', { name: 'Collections summary', exact: true }).click();
  await expect(page.getByTestId('payments-summary-equation')).toContainText('= total due now');
  await expect(page.getByTestId('payment-customer-balance')).toContainText('₹5,77,000 across 3 orders');
  await page.getByTestId('payment-select-order-order-two').scrollIntoViewIfNeeded();
  await page.getByTestId('payment-select-order-order-two').click();
  await expect(page.getByTestId('open-record-payment')).toContainText('Q-TWO');
  await expect(page.getByTestId('payment-select-order-order-two')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('open-record-payment').scrollIntoViewIfNeeded();
  await page.getByTestId('open-record-payment').click();
  await expect(page.getByTestId('pay-amount')).toHaveValue('250000.00');
  await expect(page.getByTestId('save-payment')).toBeInViewport();
});

test('critical returning from the canonical quotation refreshes the selected balance', async ({ page }) => {
  await mockSession(page, '/payments');
  let revised = false;
  const row = () => ({ ...order, grand_total: revised ? 2500 : 1200.5, outstanding: revised ? 2500 : 1200.5 });
  await page.route('**/api/payments/stats', route => route.fulfill({ json: {
    earned_total: 0, total_outstanding: row().outstanding, spending_total: 0,
    active_total: row().grand_total, active_received: 0, active_orders: 1, fully_paid: 0, collected_this_month: 0,
  } }));
  await page.route('**/api/payments/orders', route => route.fulfill({ json: [row()] }));
  await page.route('**/api/payments/orders/payment-order', route => route.fulfill({ json: { ...detail(row()), quotation_total: row().grand_total } }));
  await page.route(/\/api\/quotations\/payment-order(?:\?.*)?$/, route => route.fulfill({ json: {
    ...order, status: 'ordered', created_at: '2026-09-01', created_by_name: 'Accounts',
    items: [], rooms: [], subtotal: 1200.5, discount_total: 0,
  } }));
  await page.goto('/payments');
  await page.getByTestId('payment-open-quotation').scrollIntoViewIfNeeded();
  await page.getByTestId('payment-open-quotation').click();
  await expect(page).toHaveURL(/\/quotations\/payment-order$/);
  await expect(page.getByTestId('edit-quotation')).toBeVisible();
  revised = true;
  await page.goBack();
  await page.getByTestId('open-record-payment').scrollIntoViewIfNeeded();
  await page.getByTestId('open-record-payment').click();
  await expect(page.getByTestId('pay-amount')).toHaveValue('2500.00');
});


test('critical payment histories show Indian payment amounts without a bank method label', async ({ page }) => {
  await mockSession(page, '/payments', false);
  await page.route('**/api/payments/orders', r => r.fulfill({ json: [order] }));
  await page.route('**/api/payments/orders/payment-order', r => r.fulfill({ json: { ...detail(), payments: [{
    id: 'bank-receipt', amount: 123456.78, mode: 'bank', entry_type: 'payment', status: 'completed',
    paid_at: '2026-10-27T10:00:00Z', recorded_by_name: 'Worker',
  }] } }));
  await page.route('**/api/payments/history?**', r => r.fulfill({ json: { total: 1, items: [{
    id: 'bank-receipt', customer_id: order.customer_id, customer_name: order.customer_name,
    invoice_number: order.number, floor_id: 'first-floor', business_unit: 'Sanitary', amount: 123456.78,
    mode: 'bank', entry_type: 'payment', status: 'completed', paid_at: '2026-10-27T10:00:00Z',
  }] } }));
  await page.goto('/payments');
  const orderDetail = page.getByTestId('payments-order-detail');
  await expect(orderDetail).toContainText('₹1,23,456.78');
  await expect(orderDetail).not.toContainText('Bank Transfer');
  await page.getByTestId('payments-tabs-history').click();
  const history = page.getByTestId('payment-history-table');
  await expect(history).toContainText('₹1,23,456.78');
  await expect(history).not.toContainText('Bank Transfer');
  await expect(history.getByText('METHOD', { exact: true })).toHaveCount(0);
});
