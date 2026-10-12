import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical mobile customer PDF waits for a fresh save tap and recovers from generation failures', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  }));
  await mockSession(page, '/quotes/q-mobile');
  await page.route('**/api/portal/quotations/q-mobile', r => r.fulfill({ json: {
    id: 'q-mobile', number: 'Q-104', status: 'sent', created_at: '2026-09-01T12:00:00Z', grand_total: 1200,
    items: [], revisions: [], brands: [],
  } }));
  let fail = true;
  await page.route('**/api/quotations/q-mobile/portal-pdf', async r => {
    await new Promise(resolve => setTimeout(resolve, fail ? 100 : 6000));
    return fail ? r.fulfill({ status: 503, json: { detail: 'PDF generation failed' } }) : r.fulfill({
      contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF',
    });
  });
  await page.goto('/quotes/q-mobile');
  await page.getByTestId('download-latest-pdf').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/quotes\/q-mobile$/);
  await expect(page.getByTestId('mobile-file-save')).toHaveCount(0);
  fail = false;
  await page.getByTestId('download-latest-pdf').click();
  await expect(page.getByRole('dialog', { name: 'Save PDF' })).toBeVisible({ timeout: 15000 });
  const download = page.waitForEvent('download');
  await page.getByTestId('mobile-file-download').click();
  expect((await download).suggestedFilename()).toBe('Q-104.pdf');
  await expect(page.getByTestId('mobile-file-save')).toHaveCount(0);
  await expect(page.getByTestId('customer-quote-detail')).toBeVisible();
});

test('critical customer PDF failures recover and all document variants download', async ({ page }) => {
  await mockSession(page, '/quotes/q-portal');
  await page.route('**/api/portal/quotations/q-portal', r => r.fulfill({ json: {
    id: 'q-portal', number: 'Q-103', status: 'sent', created_at: '2026-09-01T12:00:00Z', grand_total: 1200.5,
    items: [{ id: 'line-one', name: 'Basin', sku: 'B-101', qty: 2, unit_price: 600.25, room: 'Bathroom' }],
    revisions: [{ revision_no: 1, created_at: '2026-09-01T12:00:00Z', reason: 'Finish update' }],
    brands: ['one', 'two'].map(id => ({ brand_id: id, brand_name: `Brand ${id}`, item_count: 1, subtotal: 600.25 })),
  } }));
  await page.goto('/quotes/q-portal');
  await page.getByTestId('download-latest-pdf').click();
  await expect(page.getByRole('alert')).toContainText('could not be downloaded');
  const requests: string[] = [];
  await page.route('**/api/quotations/q-portal/portal-pdf**', r => {
    requests.push(new URL(r.request().url()).pathname);
    return r.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF' });
  });
  for (const [id, filename] of [['latest-pdf', 'Q-103.pdf'], ['revision-1', 'Q-103-rev1.pdf'], ['brand-one', 'Q-103-Brand one.pdf']]) {
    const downloaded = page.waitForEvent('download');
    await page.getByTestId(`download-${id}`).click();
    expect((await downloaded).suggestedFilename()).toBe(filename);
  }
  expect(requests).toEqual(['/api/quotations/q-portal/portal-pdf', '/api/quotations/q-portal/portal-pdf/revision/1', '/api/quotations/q-portal/portal-pdf/brand/one']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('critical walk-in duplicate resolution preserves the selected customer on retry', async ({ page }) => {
  await mockSession(page, '/walkins/new');
  await page.route('**/api/walkins/config/sources', r => r.fulfill({ json: { sources: ['Walk-in'] } }));
  await page.route('**/api/walkins/config/assignees', r => r.fulfill({ json: [{ id: 'audit-owner', full_name: 'Audit Owner', role: 'owner' }] }));
  await page.route('**/api/walkins/check-duplicate?**', r => r.fulfill({ json: { high: [], medium: [{ id: 'existing-customer', name: 'Showroom customer', phone: '9000000000' }], low: [] } }));
  const writes: any[] = [];
  let fail = true;
  await page.route('**/api/walkins', r => {
    writes.push(r.request().postDataJSON());
    return fail ? r.fulfill({ status: 503, json: { detail: 'Walk-in save unavailable' } }) : r.fulfill({ json: { id: 'saved-walkin', floor_id: 'first-floor' } });
  });
  await page.goto('/walkins/new');
  await page.getByTestId('walkin-name').fill('Showroom customer');
  await page.getByTestId('walkin-phone').fill('9000000000');
  await page.getByTestId('walkin-review-matches').click();
  await page.getByTestId('walkin-use-existing-existing-customer').click();
  await page.getByTestId('walkin-save-btn').click();
  await expect(page.getByTestId('walkin-submit-error')).toContainText('Walk-in save unavailable');
  await expect(page.getByTestId('walkin-linked-customer-confirmation')).toContainText('Showroom customer');
  fail = false;
  await page.getByTestId('walkin-save-btn').click();
  await expect(page).toHaveURL(/\/walkins\/saved-walkin/);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ use_existing_customer_id: 'existing-customer', floor_id: 'first-floor', salesperson_id: 'audit-owner' });
});

test('critical customer intake retains optional details after a failed save', async ({ page }) => {
  await mockSession(page, '/customers/new');
  const writes: any[] = [];
  let fail = true;
  await page.route('**/api/customers', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
    writes.push(route.request().postDataJSON());
    return fail ? route.fulfill({ status: 503, json: { detail: 'Customer save unavailable' } }) : route.fulfill({ json: { id: 'saved-customer' } });
  });
  await page.goto('/customers/new');
  await page.getByTestId('new-customer-name').fill('Showroom customer');
  await page.getByTestId('new-customer-phone').fill('9000000000');
  const optional = page.getByRole('button', { name: 'Additional customer details', exact: true });
  await optional.click();
  await expect(optional).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('new-customer-company').fill('Project office');
  await optional.click();
  await page.getByRole('button', { name: 'Save Customer', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Customer save unavailable');
  await expect(page.getByTestId('new-customer-name')).toHaveValue('Showroom customer');
  await optional.click();
  await expect(page.getByTestId('new-customer-company')).toHaveValue('Project office');
  fail = false;
  await page.getByRole('button', { name: 'Save Customer', exact: true }).click();
  await expect(page).toHaveURL(/\/customers\/saved-customer/);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ name: 'Showroom customer', phone: '9000000000', company: 'Project office', tier: 'retail' });
});

test('critical collection failures recover and failed payment saves retain entered values', async ({ page }) => {
  await mockSession(page, '/payments');
  const order = { id: 'q-one', number: 'Q-101', customer_id: 'c-one', customer_name: 'Showroom customer', grand_total: 1200.5, paid: 0, outstanding: 1200.5, percent_collected: 0, payment_status: 'due', confirmed_at: '2026-09-01T12:00:00Z', outstanding_short: null };
  await page.goto('/payments');
  await expect(page.getByText('Could not load collections', { exact: true })).toBeVisible();
  await expect(page.getByText('No outstanding customers', { exact: true })).toHaveCount(0);
  await page.route('**/api/payments/orders', route => route.fulfill({ json: [order] }));
  await page.route('**/api/payments/orders/q-one', route => route.fulfill({ json: { ...order, status: 'ordered', customer: { id: 'c-one', name: order.customer_name, phone: '9000000000' }, floor_id: 'first-floor', mrp: 1200.5, discounted_rate: 1200.5, quotation_total: 1200.5, manual_extra_amount: 0, payments: [] } }));
  await page.getByText('Could not load collections', { exact: true }).locator('..').getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByTestId('open-record-payment').click();
  await page.getByTestId('pay-amount').fill('600.25');
  let submitted: any;
  await page.route('**/api/payments', route => { submitted = route.request().postDataJSON(); return route.fulfill({ status: 503, json: { detail: 'Payment save unavailable' } }); });
  await page.getByTestId('save-payment').click();
  await expect(page.getByRole('alert')).toContainText('Payment save unavailable');
  await expect(page.getByTestId('pay-amount')).toHaveValue('600.25');
  expect(submitted).toMatchObject({ quotation_id: 'q-one', amount: 600.25, mode: 'cash' });
});

test('last customer opens payment history in view on desktop, tablet, and phone', async ({ page }) => {
  await mockSession(page, '/payments');
  const orders = Array.from({ length: 24 }, (_, i) => ({
    id: `q-${i}`, number: `Q-${i}`, customer_id: `c-${i}`,
    customer_name: `Customer ${i}`, grand_total: 1200, paid: 200,
    outstanding: 1000, percent_collected: 17, payment_status: 'partial',
    confirmed_at: '2026-09-01T12:00:00Z', outstanding_short: null, days_unpaid: 4,
  }));
  await page.route('**/api/payments/stats', route => route.fulfill({ json: {
    earned_total: 4800, total_outstanding: 24000, spending_total: 0,
    active_total: 28800, active_received: 4800, active_orders: 24,
    fully_paid: 0, collected_this_month: 4800,
  } }));
  await page.route('**/api/payments/orders', route => route.fulfill({ json: orders }));
  await page.route('**/api/payments/orders/q-*', route => {
    const order = orders.find(item => route.request().url().endsWith(`/orders/${item.id}`))!;
    return route.fulfill({ json: {
      ...order, status: 'ordered', customer: { id: order.customer_id, name: order.customer_name },
      floor_id: 'first-floor', mrp: 1200, discounted_rate: 1200,
      quotation_total: 1200, manual_extra_amount: 0,
      payments: [{ id: `p-${order.id}`, amount: 200, mode: 'cash', paid_at: '2026-09-02T12:00:00Z' }],
    } });
  });
  await page.goto('/payments');
  if ((page.viewportSize()?.width || 0) < 768) {
    await page.getByTestId('payments-mobile-customer-switch').click();
  }
  const lastCustomer = page.getByTestId('payment-customer-c-23');
  await lastCustomer.scrollIntoViewIfNeeded();
  await lastCustomer.click();
  await expect(page.getByText('Customer 23', { exact: true }).last()).toBeVisible();
  const record = page.getByTestId('open-record-payment');
  await record.scrollIntoViewIfNeeded();
  await expect(record).toBeInViewport();
  const history = page.getByText('Payment history', { exact: true });
  await history.scrollIntoViewIfNeeded();
  await expect(history).toBeInViewport();
});

test('critical notifications link to existing records and offline state does not replay writes', async ({ page }) => {
  await mockSession(page, '/notifications');
  let writes = 0;
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes++; });
  await page.route('**/api/notifications', route => route.fulfill({ json: [{ id: 'n-one', title: 'Quotation updated', body: 'Review the latest customer quotation.', kind: 'info', read: false, created_at: '2026-09-01T12:00:00Z', link: '/quotations/q-one' }] }));
  await page.goto('/notifications');
  await expect(page.getByRole('link', { name: 'Unread: Quotation updated. Open record' })).toBeVisible();
  await page.context().setOffline(true);
  await expect(page.getByRole('status')).toContainText('offline');
  await page.context().setOffline(false);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(writes).toBe(0);
  await page.getByRole('link', { name: 'Unread: Quotation updated. Open record' }).click();
  await expect(page).toHaveURL(/\/quotations\/q-one/);
});

test('critical payment tabs expose selection and support keyboard navigation with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockSession(page, '/payments');
  await page.goto('/payments');
  const collections = page.getByTestId('payments-tabs-collections');
  const history = page.getByTestId('payments-tabs-history');
  await collections.focus();
  await expect(collections).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(history).toBeFocused();
  await expect(history).toHaveAttribute('aria-selected', 'true');
  const outline = await history.evaluate(el => getComputedStyle(el).outlineStyle);
  expect(outline).toBe('solid');
  await page.keyboard.press('Home');
  await expect(collections).toBeFocused();
});

test('critical quotation picker keeps nested dialogs isolated and preserves selected products', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSession(page, '/quotations/new');
  await page.route('**/api/customers', r => r.fulfill({ json: [] }));
  await page.route('**/api/categories**', r => r.fulfill({ json: [{ id: 'basins', name: 'Basins' }] }));
  await page.route('**/api/brands**', r => r.fulfill({ json: [{ id: 'brand-one', name: 'Fixture brand' }] }));
  await page.route('**/api/products/families?**', r => r.fulfill({ json: { total: 1, items: [{ family_key: 'basin', family_name: 'Basin', category_id: 'basins', brand_id: 'brand-one', min_price: 600.25, variants: [{ id: 'basin-white', sku: 'B-101', name: 'Basin', price: 600.25, mrp: 600.25, stock: 2, finish: 'White' }] }] } }));
  await page.goto('/quotations/new');
  const add = page.getByTestId('mobile-add-first');
  await expect(add).toBeVisible();
  await add.click();
  const picker = page.getByRole('dialog', { name: 'Add products', exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'View Basin', exact: true }).click();
  const product = page.getByRole('dialog', { name: 'Basin', exact: true });
  await expect(product).toBeVisible();
  await expect(picker).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(product).toHaveCount(0);
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'View Basin', exact: true }).click();
  await page.getByTestId('pm-add-close').click();
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('1 items in quotation');
  await page.getByTestId('picker-view-quotation').click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('mobile-finalize')).toBeDisabled(); // Customer is still required.
  await page.screenshot({ path: info.outputPath('quotation-selected.png'), fullPage: true });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('forge.builder.draft.v1.audit-owner.first-floor'))).not.toBeNull();
  await page.reload();
  const recovery = page.getByRole('dialog', { name: 'Recover quotation draft', exact: true });
  await expect(recovery).toContainText('1 item');
  await page.keyboard.press('Escape');
  await expect(recovery).toBeVisible();
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await expect(page.getByText('Basin', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('mobile-finalize')).toBeDisabled();
});

test('critical multi-brand order review retains supplier choices after failure and confirms once', async ({ page }) => {
  await mockSession(page, '/quotations/q-order/place-order');
  const brands = ['one', 'two'].map(key => ({ brand_id: key, brand_name: `Brand ${key}`, item_count: 1, subtotal: 600.25, items: [{ line_id: `line-${key}`, product_id: `product-${key}`, sku: `SKU-${key}`, name: `Basin ${key}`, qty: 1, unit_cost: 600.25 }], default_supplier: { id: `supplier-${key}`, name: `Supplier ${key}` } }));
  await page.route('**/api/quotations/q-order/place-order/preview', r => r.fulfill({ json: { quotation_id: 'q-order', quotation_number: 'Q-102', doc_type: 'standard', customer_id: 'c-one', customer_name: 'Showroom customer', total_value: 1200.5, brands } }));
  await page.route('**/api/suppliers', r => r.fulfill({ json: brands.map(b => ({ ...b.default_supplier, brand_id: b.brand_id })) }));
  const writes: any[] = [];
  let fail = true;
  await page.route('**/api/quotations/q-order/place-order/confirm', r => {
    writes.push(r.request().postDataJSON());
    return fail ? r.fulfill({ status: 503, json: { detail: 'Order confirmation unavailable' } }) : r.fulfill({ json: { purchase_orders: [{ id: 'po-one' }, { id: 'po-two' }], count: 2 } });
  });
  await page.goto('/quotations/q-order/place-order');
  await page.getByTestId('project-name').fill('Showroom renovation');
  await page.getByTestId('notes-one').fill('Keep the finish consistent');
  await page.getByTestId('confirm-place-order').click();
  await expect(page.getByRole('alert')).toContainText('Order confirmation unavailable');
  await expect(page.getByTestId('notes-one')).toHaveValue('Keep the finish consistent');
  fail = false;
  await page.getByTestId('confirm-place-order').click();
  await expect(page).toHaveURL(/purchases/);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ supplier_by_brand: { one: 'supplier-one', two: 'supplier-two' }, notes_by_brand: { one: 'Keep the finish consistent' }, project_name: 'Showroom renovation' });
});
