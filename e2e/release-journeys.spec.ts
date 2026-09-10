import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const followup = (id: string, name: string) => ({
  id, customer_id: id, customer_name: name, customer_tier: 'retail', customer_phone: '9000000000',
  rule_type: 'manual', category: 'general', value: 12000, reason: 'Confirm the delivery date', reason_factors: [],
  next_action: 'Call customer', next_action_reason: 'Delivery confirmation', suggested_channel: 'call',
  priority_score: 70, priority_level: 'high', due_at: new Date().toISOString(), status: 'open',
  is_automated: false, auto_resolved: false, contact_attempts: 0, tags: [], bucket: 'today',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), assigned_to: 'audit-owner',
});

async function followupsSession(page: Page) {
  await mockSession(page, '/followups');
  await page.route('**/api/followups/config/assignees', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  await page.route('**/api/customers', route => route.fulfill({ json: [] }));
  // Optional summaries intentionally fail. The primary task queue must remain usable.
}

test('critical Follow-ups optional failure preserves queue and server search finds distant records', async ({ page }, info) => {
  await followupsSession(page);
  const requests: string[] = [];
  await page.route('**/api/followups/page?**', route => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    const searched = url.searchParams.get('q') === 'Customer 1201';
    return route.fulfill({ json: { items: [followup(searched ? '1201' : '1', searched ? 'Customer 1201' : 'First Customer')], page: 1, page_size: 100, has_more: false } });
  });
  await page.goto('/followups');
  await expect(page.getByTestId('followup-1')).toBeVisible();
  await expect(page.getByText('Follow-ups are unavailable', { exact: true })).toHaveCount(0);
  await page.getByTestId('followups-search').fill('Customer 1201');
  await expect(page.getByTestId('followup-1201')).toBeVisible();
  await expect(page.getByTestId('followup-1')).toHaveCount(0);
  expect(requests.some(query => new URLSearchParams(query).get('q') === 'Customer 1201')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('followups-populated.png'), fullPage: true });
});

test('critical Follow-ups bulk partial failure retains failed records and retries only failures', async ({ page }) => {
  await followupsSession(page);
  await page.route('**/api/followups/page?**', route => route.fulfill({ json: {
    items: [followup('one', 'Asha Customer'), followup('two', 'Bharat Customer')], page: 1, page_size: 100, has_more: false,
  } }));
  const mutations: string[] = [];
  await page.route('**/api/followups/*/complete', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    mutations.push(id);
    return id === 'two' && mutations.filter(value => value === id).length === 1
      ? route.fulfill({ status: 409, json: { detail: 'Record changed. Retry.' } })
      : route.fulfill({ json: { ok: true } });
  });
  await page.goto('/followups');
  await page.getByTestId('followup-one').getByLabel('Select', { exact: true }).click();
  await page.getByTestId('followup-two').getByLabel('Select', { exact: true }).click();
  await page.getByRole('button', { name: 'Complete', exact: true }).first().click();
  await expect(page.getByText('1 updated, 1 failed', { exact: true })).toBeVisible();
  expect(mutations.sort()).toEqual(['one', 'two']);
  await page.getByRole('button', { name: 'Retry failed', exact: true }).click();
  await expect.poll(() => mutations.length).toBe(3);
  expect(mutations.filter(id => id === 'one')).toHaveLength(1);
  expect(mutations.filter(id => id === 'two')).toHaveLength(2);
  await expect(page.getByRole('button', { name: 'Retry failed', exact: true })).toHaveCount(0);
});

test('critical Follow-ups failed queue shows recovery and page navigation bounds mounted records', async ({ page }) => {
  await followupsSession(page);
  let fail = true;
  await page.route('**/api/followups/page?**', route => {
    if (fail) return route.fulfill({ status: 503, json: { detail: 'Queue temporarily unavailable' } });
    const number = Number(new URL(route.request().url()).searchParams.get('page'));
    return route.fulfill({ json: { items: [followup(`page-${number}`, `Page ${number} Customer`)], page: number, page_size: 100, has_more: number < 3 } });
  });
  await page.goto('/followups');
  await expect(page.getByText('Follow-ups are unavailable', { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('followup-page-1')).toBeVisible();
  await page.getByTestId('followups-next-page').click();
  await expect(page.getByTestId('followup-page-2')).toBeVisible();
  await expect(page.getByTestId('followup-page-1')).toHaveCount(0);
  await page.getByTestId('followups-previous-page').click();
  await expect(page.getByTestId('followup-page-1')).toBeVisible();
  await expect(page.getByTestId('followup-page-2')).toHaveCount(0);
});

test('critical Tile Orders bounded pages preserve quantities and search resets paging', async ({ page }, info) => {
  await mockSession(page, '/tiles/orders');
  const requests: URL[] = [];
  await page.route('**/api/tile-orders/customer-orders?**', route => {
    const url = new URL(route.request().url()); requests.push(url);
    const number = Number(url.searchParams.get('page') || 1);
    const name = url.searchParams.get('search') ? 'Matched Customer' : `Customer Page ${number}`;
    return route.fulfill({ json: { orders: [{
      id: `order-${number}`, number: `TCO-00${number}`, customer_name: name, customer_phone: '9000000000',
      order_date: '2026-09-08T12:00:00Z', waiting_days: 2, ageing_band: 'green', brands: [],
      total_products: 3, total_boxes: 24, total_value: 48000, overall_status: 'Partially Dispatched', completion_percentage: 50,
    }], page: number, page_size: 30, total: 61, has_more: number < 3, next_page: number < 3 ? number + 1 : null } });
  });
  await page.goto('/tiles/orders');
  await expect(page.getByText('Customer Page 1', { exact: true })).toBeVisible();
  await page.getByTestId('tile-orders-load-more').click();
  await expect(page.getByText('Customer Page 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Customer Page 1', { exact: true })).toHaveCount(0);
  await page.getByTestId('tile-orders-previous-page').click();
  await expect(page.getByText('Customer Page 1', { exact: true })).toBeVisible();
  await page.getByTestId('tile-orders-customer-search').fill('Matched');
  await expect(page.getByText('Matched Customer', { exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get('page')).toBe('1');
  expect(requests.at(-1)?.searchParams.get('search')).toBe('Matched');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('tile-orders-populated.png'), fullPage: true });
});
