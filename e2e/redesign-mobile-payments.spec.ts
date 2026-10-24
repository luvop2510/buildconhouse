import { expect, test, type Page } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

const base = {
  grand_total: 1000, effective_order_total: 1000, paid: 0, cash_received: 0,
  outstanding: 1000, percent_collected: 0, payment_status: 'due',
  confirmed_at: '2026-09-01T12:00:00Z', days_unpaid: 20, refund_due: 0,
};
const orders = [
  { ...base, id: 'due', number: 'Q-DUE', customer_id: 'c-due', customer_name: 'Due client' },
  { ...base, id: 'partial', number: 'Q-PART', customer_id: 'c-partial', customer_name: 'Partial client', paid: 300, cash_received: 300, outstanding: 700, payment_status: 'partial' },
  { ...base, id: 'paid', number: 'Q-PAID', customer_id: 'c-paid', customer_name: 'Paid client', paid: 1000, cash_received: 1000, outstanding: 0, payment_status: 'paid' },
  { ...base, id: 'credit', number: 'Q-CREDIT', customer_id: 'c-credit', customer_name: 'Stock credit client', paid: 200, cash_received: 0, outstanding: 800, payment_status: 'partial' },
  { ...base, id: 'refund', number: 'Q-REFUND', customer_id: 'c-refund', customer_name: 'Refund client', paid: 1000, cash_received: 1000, effective_order_total: 800, refund_due: 200, outstanding: 0, payment_status: 'paid' },
];
async function fixture(page: Page) {
  await mockSession(page, '/payments', false);
  await page.route('**/api/settings/floors', route => route.fulfill({ json: floors }));
  await page.route('**/api/payments/stats', route => route.fulfill({ json: {
    earned_total: 2100, refund_due_total: 200, total_outstanding: 2500, spending_total: 4000,
    active_total: 2800, active_received: 300, active_orders: 3, fully_paid: 2, collected_this_month: 2300,
  } }));
  await page.route(/\/api\/payments\/orders(?:\?|$)/, route => {
    const params = new URL(route.request().url()).searchParams;
    const scope = params.get('status_filter');
    return route.fulfill({ json: orders.filter(row => scope === 'all' || (scope ? row.payment_status === scope : row.payment_status !== 'paid')) });
  });
  await page.route(/\/api\/payments\/orders\/[^/?]+$/, route => {
    const row = orders.find(order => route.request().url().endsWith(`/${order.id}`))!;
    return route.fulfill({ json: { ...row, status: 'ordered', floor_id: 'first-floor',
      customer: { id: row.customer_id, name: row.customer_name }, quotation_total: 1000,
      manual_extra_amount: 0, mrp: 1000, discounted_rate: 1000, payments: [],
    } });
  });
}
async function openSummary(page: Page) {
  const summary = page.getByRole('button', { name: 'Collections summary', exact: true });
  if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click();
}

test('critical payment page heading keeps the same safe gutter as the collection content', async ({ page }) => {
  await fixture(page);
  await page.goto('/payments');
  await expect(page.getByTestId('wa-reminder-btn')).toBeVisible();
  const heading = page.getByRole('heading', { name: 'Payments', exact: true }).first();
  const title = await heading.boundingBox();
  const scroll = await page.getByTestId('payments-collections-scroll').boundingBox();
  expect(title!.x - scroll!.x, 'Payments title must not touch the workspace edge').toBeGreaterThanOrEqual(16);
});

test('critical payment summary opens matching earned, partial, refund and outstanding customers', async ({ page }) => {
  await fixture(page);
  await page.goto('/payments');
  // The debounced initial order read replaces the loading/queue layout with
  // the selected order. Measure the ready page so that replacement cannot
  // reset the scroll between the gesture and its geometry assertion.
  await expect(page.getByTestId('wa-reminder-btn')).toBeVisible();
  if ((page.viewportSize()?.width || 0) < 768) {
    const chrome = page.getByTestId('mobile-workspace-header');
    const scroll = page.getByTestId('payments-collections-scroll');
    const contentTitle = page.getByRole('heading', { name: 'Payments', exact: true }).last();
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(20);
    const chromeTop = (await chrome.boundingBox())?.y;
    const titleTop = (await contentTitle.boundingBox())?.y;
    await scroll.evaluate(element => { element.scrollTop = 360; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await expect.poll(async () => (await contentTitle.boundingBox())?.y).toBeLessThan((titleTop || 360) - 20);
    expect((await chrome.boundingBox())?.y).toBe(chromeTop);
    await scroll.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  }
  await openSummary(page);
  await expect(page.getByRole("button", { name: "View spending", exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View earned', exact: true }).click();
  await expect(page.getByTestId('payment-customer-c-paid')).toBeVisible();
  await expect(page.getByTestId('payment-customer-c-partial')).toBeVisible();
  await expect(page.getByTestId('payment-customer-c-refund')).toBeVisible();
  await expect(page.getByTestId('payment-customer-c-due')).toHaveCount(0);
  await expect(page.getByTestId('payment-customer-c-credit')).toHaveCount(0);
  await expect(page.getByTestId('payment-customer-c-paid')).toContainText('earned');
  await page.getByRole('button', { name: 'View received on active orders', exact: true }).click();
  await expect(page.getByTestId('payment-customer-c-partial')).toBeVisible();
  await expect(page.getByTestId('payment-customer-c-paid')).toHaveCount(0);
  await expect(page.getByTestId('payment-customer-c-credit')).toHaveCount(0);
  await page.getByRole('button', { name: 'View refund due', exact: true }).click();
  await expect(page.getByTestId('payment-customer-c-refund')).toBeVisible();
  await expect(page.getByTestId('payment-customer-c-partial')).toHaveCount(0);
  await expect(page.getByTestId('payment-customer-c-refund')).toContainText('refund due');
  await page.getByRole('button', { name: 'View total due now', exact: true }).click();
  await expect(page.getByTestId('payment-customer-c-due')).toBeVisible();
  await expect(page.getByTestId('payment-customer-c-credit')).toBeVisible();
  await expect(page.getByTestId('payment-customer-c-paid')).toHaveCount(0);
  await expect(page.getByTestId('payments-clear-summary')).toHaveCount(0);
});

test('critical mobile payment history and collection filters hide without clearing selections', async ({ page }) => {
  await fixture(page);
  const requests: URL[] = [];
  await page.route('**/api/payments/history?**', route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: { total: 0, items: [] } });
  });
  await page.goto('/payments');
  if ((page.viewportSize()?.width || 0) < 768) {
    await page.getByTestId('payments-mobile-customer-switch').click();
    await page.getByTestId('payments-aging-filter').click();
    await page.getByRole('menuitem', { name: '1+ week', exact: true }).click();
    await page.getByTestId('payments-filters-toggle').click();
    await expect(page.getByTestId('payments-aging-filter')).toBeHidden();
    await expect(page.getByTestId('payments-search')).toBeVisible();
    await page.getByTestId('payments-filters-toggle').click();
    await expect(page.getByTestId('payments-aging-filter')).toContainText('1+ week');
  }
  await page.getByTestId('payments-tabs-history').click();
  await page.getByTestId('history-unit-filter-first-floor').click();
  await page.getByTestId('history-mode-filter-cash').click();
  await page.getByTestId('history-date-from').fill('2026-09-01');
  await expect.poll(() => requests.at(-1)?.searchParams.get('date_from')).toBe('2026-09-01');
  if ((page.viewportSize()?.width || 0) < 768) {
    await page.getByTestId('history-filters-toggle').click();
    await expect(page.getByTestId('history-unit-filter')).toBeHidden();
    await expect(page.getByTestId('history-mode-filter')).toBeHidden();
    await expect(page.getByTestId('history-date-from')).toBeHidden();
    await expect(page.getByTestId('history-search')).toBeVisible();
    await page.getByTestId('history-filters-toggle').click();
  }
  await expect(page.getByTestId('history-date-from')).toHaveValue('2026-09-01');
  expect(requests.at(-1)?.searchParams.get('business_unit')).toBe('first-floor');
  expect(requests.at(-1)?.searchParams.get('mode')).toBe('cash');
});

test('critical fully paid filters hide and retain their business unit', async ({ page }) => {
  await mockSession(page, '/payments-list', false);
  await page.route('**/api/settings/floors', route => route.fulfill({ json: floors }));
  const requests: URL[] = [];
  await page.route('**/api/payments/fully-paid-orders?**', route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: { total: 1, items: [{ id: 'paid-order', number: 'Q-PAID', customer_name: 'Paid client', grand_total: 1000, received: 1000, outstanding: 0 }] } });
  });
  await page.goto('/payments-list');
  await expect(page.getByTestId('payment-list-row-paid-order')).toBeVisible();
  await page.getByRole('button', { name: 'All business units', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Tiles', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get('business_unit')).toBe('ground-floor');
  if ((page.viewportSize()?.width || 0) < 768) {
    await page.getByTestId('payment-list-filters-toggle').click();
    await expect(page.getByRole('button', { name: 'Tiles', exact: true })).toBeHidden();
    await expect(page.getByTestId('payment-list-search')).toBeVisible();
    await page.getByTestId('payment-list-filters-toggle').click();
  }
  await expect(page.getByRole('button', { name: 'Tiles', exact: true })).toBeVisible();
});
