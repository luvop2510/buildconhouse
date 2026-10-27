import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

test('critical payment history combines units and methods and clears every choice', async ({ page }) => {
  await mockSession(page, '/payments', false);
  await page.route('**/api/settings/floors', route => route.fulfill({ json: floors }));
  let latest = new URLSearchParams();
  await page.route('**/api/payments/history?**', route => {
    latest = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { total: 0, items: [] } });
  });
  await page.goto('/payments');
  await page.getByTestId('payments-tabs-history').click();
  for (const id of ['history-unit-filter-first-floor', 'history-unit-filter-second-floor', 'history-mode-filter-cash', 'history-mode-filter-upi']) {
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveAttribute('aria-checked', 'true');
  }
  await expect.poll(() => latest.get('business_unit')).toBe('first-floor,second-floor');
  await expect.poll(() => latest.get('mode')).toBe('cash,upi');
  await page.getByTestId('history-unit-filter-all').click();
  await expect(page.getByTestId('history-unit-filter-all')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('history-mode-filter-all').click();
  await expect(page.getByTestId('history-mode-filter-all')).toHaveAttribute('aria-checked', 'true');
  for (const id of ['history-unit-filter-first-floor', 'history-unit-filter-second-floor', 'history-mode-filter-cash', 'history-mode-filter-upi']) {
    await expect(page.getByTestId(id)).toHaveAttribute('aria-checked', 'false');
  }
  // Clearing can reuse the initial unfiltered response within its short TTL.
  await expect(page.getByText('No completed payments yet', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical purchase filters combine customers and stages on the rail and mobile sheet', async ({ page }) => {
  await mockSession(page, '/purchases', false);
  const stages = [{ key: 'po_final', label: 'PO Final', count: 0 }, { key: 'in_box', label: 'Inbox', count: 0 }].map(stage => ({ ...stage, tone: { bg: '#eee', fg: '#222' } }));
  await page.route('**/api/purchases/customer-workspaces?**', route => route.fulfill({ json: [{ id: 'c1', name: 'Buyer One' }, { id: 'c2', name: 'Buyer Two' }] }));
  await page.route('**/api/purchases/stages', route => route.fulfill({ json: stages }));
  await page.route('**/api/purchases/brands', route => route.fulfill({ json: { all: 0, brands: [] } }));
  await page.route('**/api/purchases/shortages?**', route => route.fulfill({ json: { items: [] } }));
  let latest = new URLSearchParams();
  await page.route('**/api/purchases/items/page?**', route => {
    latest = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { items: [], total: 0, next_skip: null, has_more: false, summaries: { sla_days: 7, blocked_count: 0, stage_counts: {} } } });
  });
  await page.goto('/purchases');
  await page.getByTestId('view-stock').click();
  if (page.viewportSize()!.width < 1366) {
    await page.getByTestId('purchases-filter-button').click();
    await page.getByRole('button', { name: 'Buyer One', exact: true }).click();
    await page.getByRole('button', { name: 'Buyer Two', exact: true }).click();
    await page.getByRole('button', { name: 'PO Final (0)', exact: true }).click();
    await page.getByRole('button', { name: 'Inbox (0)', exact: true }).click();
    await page.getByTestId('apply-purchase-filters').click();
  } else {
    await page.getByRole('button', { name: 'Filter stock for Buyer One', exact: true }).click();
    await page.getByRole('button', { name: 'Filter stock for Buyer Two', exact: true }).click();
    await page.getByText('PO Final', { exact: true }).click();
    await page.getByText('Inbox', { exact: true }).click();
  }
  await expect.poll(() => latest.get('customer')).toBe('c1,c2');
  await expect.poll(() => latest.get('stage')).toBe('po_final,in_box');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical customer purchase workspace combines brand and stage choices', async ({ page }) => {
  await mockSession(page, '/customers/multi-client', false);
  const customer = { id: 'multi-client', name: 'Multi Client', email: '', tier: 'retail' };
  await page.route(/\/api\/customers\/multi-client(?:\?.*)?$/, route => route.fulfill({ json: customer }));
  await page.route('**/api/quotations', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/activity/customer/multi-client', route => route.fulfill({ json: [] }));
  let latest = new URLSearchParams();
  await page.route('**/api/purchases/customers/multi-client/workspace**', route => {
    latest = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: {
      customer, summary: { total_items: 0, total_value: 0, outstanding_value: 0, outstanding_count: 0, open_pos: 0, blocked_count: 0, delivered_count: 0, shortage_count: 0 },
      shortages: [], products: [], outstanding_items: [], purchase_orders: [], recent_activity: [], expected_delivery: { next_at: null, purchase_orders: [] },
      brands: [{ id: 'b1', name: 'Brand One', count: 1 }, { id: 'b2', name: 'Brand Two', count: 1 }],
      stages: [{ key: 'po_final', label: 'PO Final', count: 1 }, { key: 'in_box', label: 'Inbox', count: 1 }],
    } });
  });
  await page.goto('/customers/multi-client');
  await page.getByRole('tab', { name: /^Purchases/ }).click();
  for (const id of ['customer-workspace-brand-b1', 'customer-workspace-brand-b2', 'customer-workspace-stage-po_final', 'customer-workspace-stage-in_box']) {
    await page.getByTestId(id).click();
  }
  await expect.poll(() => latest.get('brand')).toBe('b1,b2');
  await expect.poll(() => latest.get('stage')).toBe('po_final,in_box');
  await expect(page.getByTestId('customer-workspace-clear-brand')).toContainText('Brand One, Brand Two');
  await expect(page.getByTestId('customer-workspace-clear-stage')).toContainText('PO Final, Inbox');
});
