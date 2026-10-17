import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const customer = { id: 'delivered', name: 'Completed Buyer', company: 'Completed Buyer', email: 'buyer@example.test', purchase_completion_status: 'completed' };

test('critical Customer active and 100 percent views request shared fulfillment and hide removed tiers', async ({ page }) => {
  await mockSession(page, '/customers', false);
  const requests: string[] = [];
  await page.route('**/api/customers?**', route => {
    const view = new URL(route.request().url()).searchParams.get('completion') || '';
    requests.push(view);
    return route.fulfill({ json: view === 'completed' ? [customer] : [{ ...customer, id: 'open', name: 'Active Buyer', company: 'Active Buyer', purchase_completion_status: 'active' }] });
  });
  await page.goto('/customers');
  await expect(page.getByTestId('customer-open')).toBeVisible();
  await expect(page.getByTestId('customer-delivered')).toHaveCount(0);
  await page.getByTestId('customers-completed-tab').click();
  await expect(page.getByTestId('customer-delivered')).toBeVisible();
  await expect(page.getByTestId('customer-open')).toHaveCount(0);
  await expect(page.getByText('100% completed', { exact: true })).toBeVisible();
  await expect(page.getByText(/^(VIP|Trade|Retail)$/)).toHaveCount(0);
  await page.getByTestId('customers-active-tab').click();
  await expect(page.getByTestId('customer-open')).toBeVisible();
  expect(requests).toContain('active');
  expect(requests).toContain('completed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

for (const [path, rowPrefix, kind] of [['/quotations', 'quotation', 'standard'], ['/tiles', 'tiles-doc', 'tiles_quotation']] as const) {
  test(`critical ${path} Completed includes fulfilled orders without an extra customer page`, async ({ page }) => {
    await mockSession(page, path, false);
    const requests: URL[] = [];
    await page.route('**/api/quotations?**', route => {
      const url = new URL(route.request().url()); requests.push(url);
      const type = url.searchParams.get('doc_type');
      return route.fulfill({ json: [{ id: `done-${type}`, number: 'Q-DONE', doc_type: type, customer_name: 'Completed Buyer', status: 'ordered', grand_total: 250, created_at: '2026-10-10', updated_at: '2026-10-10', items: [], purchase_completion_status: 'completed' }] });
    });
    await page.goto(`${path}?view=completed`);
    await expect(page.getByTestId(`${rowPrefix}-done-${kind}`)).toBeVisible();
    await expect(page.getByText('100% completed', { exact: true })).toBeVisible();
    await expect(page.getByTestId(path === '/tiles' ? 'tiles-fulfilled-toggle' : 'quotations-fulfilled-toggle')).toHaveCount(0);
    expect(requests.some(url => url.searchParams.get('view') === 'completed' && !url.searchParams.has('completion'))).toBe(true);
    await page.goto(`${path}?view=fulfilled`);
    await expect(page.getByTestId(`${rowPrefix}-done-${kind}`)).toBeVisible();
    await expect(page.getByText(/100% Customers/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

for (const action of ['move', 'transfer'] as const) {
  test(`critical Purchases ${action} refreshes the customer rail immediately`, async ({ page }) => {
    await mockSession(page, '/purchases', false);
    const item = { item_id: 'item-completion', po_id: 'po-completion', po_number: 'PO-C', name: 'Completion shower', sku: 'C-1', customer_id: 'buyer', customer_name: 'Completion Buyer', brand_name: 'Example Brand', qty: 2, unit_cost: 100, stage: 'in_box', stage_label: 'Inbox', blocked: false, age_days: 1 };
    const stages = ['po_final', 'order_in_company', 'company_billing', 'in_box', 'dispatched'].map(key => ({ key, label: key === 'dispatched' ? 'Dispatched' : key, count: 0, tone: { bg: '#eeeeee', fg: '#222222' } }));
    let mutated = false;
    let refreshedAfterMutation = false;
    await page.route('**/api/purchases/customer-workspaces?**', route => {
      refreshedAfterMutation ||= mutated;
      return route.fulfill({ json: mutated && action === 'move' ? [] : [{ id: 'buyer', name: 'Completion Buyer' }] });
    });
    await page.route('**/api/purchases/stages', route => route.fulfill({ json: stages }));
    await page.route('**/api/purchases/brands', route => route.fulfill({ json: { all: 1, brands: [] } }));
    await page.route('**/api/purchases/shortages**', route => route.fulfill({ json: { items: [] } }));
    await page.route('**/api/purchases/items/page?**', route => route.fulfill({ json: { items: [item], total: 1, next_skip: null, summaries: { sla_days: 7, blocked_count: 0, stage_counts: { in_box: 1 } } } }));
    await page.route('**/api/purchases/customers/buyer/workspace', route => route.fulfill({ json: { customer: { id: 'buyer', name: 'Completion Buyer' }, summary: { outstanding_count: 1, open_pos: 1, blocked_count: 0, outstanding_value: 200, outstanding_balance: 0 }, products: [item] } }));
    await page.route('**/api/purchases/items/item-completion/eligible-recipients', route => route.fulfill({ json: [{ id: 'recipient', name: 'Recipient Buyer' }] }));
    await page.route(`**/api/purchases/items/item-completion/${action}`, route => {
      mutated = true;
      return route.fulfill({ json: action === 'move' ? { split: false, qty_moved: 2 } : { destination: { customer_name: 'Recipient Buyer' } } });
    });
    await page.goto('/purchases');
    await page.getByTestId('view-customers').click();
    await page.getByTestId('customer-workspace-buyer').click();
    await page.getByRole('button', { name: `${action === 'move' ? 'Move' : 'Transfer'} Completion shower`, exact: true }).click();
    if (action === 'move') {
      await page.getByTestId('movement-stage-dispatched').click();
      await page.getByTestId('movement-move-submit').click();
    } else {
      await page.getByTestId('transfer-pick-recipient').click();
      await page.getByTestId('movement-transfer-submit').click();
    }
    await expect.poll(() => refreshedAfterMutation).toBe(true);
    if (action === 'move') await expect(page.getByTestId('customer-workspace-buyer')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

for (const kind of ['standard', 'tiles_quotation'] as const) {
  for (const completion of ['active', 'completed'] as const) {
    test(`critical saved ${kind} editor shows delivery completion independently of order approval: ${completion}`, async ({ page }) => {
      const path = kind === 'standard' ? '/quotations/new?quotationId=editor-completion' : '/tiles/quotation?id=editor-completion';
      await mockSession(page, path, false);
      const requests: { completion: string | null; floor: string | undefined }[] = [];
      await page.route('**/api/quotations/editor-completion*', route => {
        requests.push({ completion: new URL(route.request().url()).searchParams.get('with_completion'), floor: route.request().headers()['x-floor-id'] });
        return route.fulfill({ json: { id: 'editor-completion', number: 'Q-COMPLETE', customer_id: 'delivered', customer_name: 'Completed Buyer', doc_type: kind, status: 'ordered', purchase_completion_status: completion, items: [], rooms: ['Room 1'], subtotal: 0, grand_total: 0, updated_at: '2026-10-12T10:00:00Z' } });
      });
      await page.goto(path);
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      if (kind === 'standard' && (page.viewportSize()?.width ?? 1440) < 700) {
        await page.getByRole('button', { name: 'Show quotation workspace', exact: true }).click();
      }
      if (completion === 'completed') await expect(page.getByTestId('quotation-customer-completed')).toHaveText('100% completed');
      else {
        await expect(page.getByText(/Q-COMPLETE/).first()).toBeVisible();
        await expect(page.getByTestId('quotation-customer-completed')).toHaveCount(0);
      }
      expect(requests.every(request => request.completion === 'true' && request.floor === (kind === 'standard' ? 'first-floor' : 'ground-floor'))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    });
  }
}
