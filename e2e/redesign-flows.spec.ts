import { expect, test } from '@playwright/test';
import { mockSession, floors } from './audit-fixtures';

const walkin = {
  id: 'audit-walkin', number: 'WI-101', customer_id: 'audit-customer', customer_name: 'Asha Project',
  customer_phone: '9000000000', alternate_phone: null, visited_at: '2026-09-11T09:00:00Z',
  salesperson_id: 'audit-owner', salesperson_name: 'Audit Owner', source: 'Showroom', floor_id: 'first-floor',
  interested_products: ['Basin'], budget: null, notes: 'Confirm the finish', status: 'new',
  created_at: '2026-09-11T09:00:00Z', updated_at: '2026-09-11T09:00:00Z',
};

test('critical walk-in register retries a failed request into a populated customer journey', async ({ page }) => {
  await mockSession(page, '/walkins');
  let fail = true;
  await page.route('**/api/walkins/dashboard', route => route.fulfill({ json: {
    today_walkins: 1, this_week: 1, pending_followups: 1, selections_scheduled: 0, converted: 0, lost: 0, conversion_rate: 0, avg_conversion_days: 0, total: 1,
  } }));
  await page.route(/\/api\/walkins(?:\?|$)/, route => fail ? route.fulfill({ status: 503, json: { detail: 'Register temporarily unavailable' } }) : route.fulfill({ json: [walkin] }));
  await page.goto('/walkins');
  await expect(page.getByText('Could not load walk-ins', { exact: true })).toBeVisible();
  await expect(page.getByText('No walk-ins yet', { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText(walkin.customer_name, { exact: true })).toBeVisible();
  await expect(page.getByText('Could not load walk-ins', { exact: true })).toHaveCount(0);
});

test('critical walk-in detail exits its loading state after recovery', async ({ page }) => {
  await mockSession(page, '/walkins/audit-walkin');
  await page.goto('/walkins/audit-walkin');
  await expect(page.getByText('Could not load walk-in', { exact: true })).toBeVisible();
  await page.route('**/api/walkins/audit-walkin', route => route.fulfill({ json: walkin }));
  await page.route('**/api/walkins/audit-walkin/timeline', route => route.fulfill({ json: [] }));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText(walkin.customer_name, { exact: true })).toBeVisible();
  await expect(page.getByText('No activity yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('Could not load walk-in', { exact: true })).toHaveCount(0);
});

test('critical fully paid orders distinguish service failure from an empty ledger', async ({ page }) => {
  await mockSession(page, '/payments-list');
  await page.goto('/payments-list');
  await expect(page.getByText('Could not load fully paid orders', { exact: true })).toBeVisible();
  await expect(page.getByText('No fully paid orders yet', { exact: true })).toHaveCount(0);
  await page.route('**/api/payments/list?**', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No fully paid orders yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
});

test('critical notebook retry retains its department and recovers to an honest empty register', async ({ page }) => {
  await mockSession(page, '/notebook/kitchen');
  await page.goto('/notebook/kitchen');
  await expect(page.getByText('Register unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('No walk-ins yet', { exact: true })).toHaveCount(0);
  const requestedFloors: string[] = [];
  await page.route('**/api/followups/notebook/second-floor?**', route => {
    requestedFloors.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { rows: [], next_cursor: null } });
  });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No walk-ins yet', { exact: true })).toBeVisible();
  expect(requestedFloors).toEqual(['/api/followups/notebook/second-floor']);
});

test('critical order preview shows progressive loading, recovers and retains the original items', async ({ page }) => {
  await mockSession(page, '/quotations/audit-quote/place-order');
  await page.goto('/quotations/audit-quote/place-order');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/suppliers', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/audit-quote/place-order/preview', async route => {
    await gate;
    return route.fulfill({ json: {
      quotation_id: 'audit-quote', quotation_number: 'Q-101', doc_type: 'standard', customer_id: 'audit-customer', customer_name: 'Asha Project', total_value: 1200,
      brands: [{ brand_id: 'audit-brand', brand_name: 'Fixture Brand', subtotal: 1200, item_count: 1, items: [{ line_id: 'line-one', product_id: 'product-one', sku: 'B-101', name: 'Basin', qty: 2, unit_cost: 600 }] }],
    } });
  });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Preparing items, brands and suppliers…', { exact: true })).toBeVisible();
  await expect(page.getByTestId('confirm-place-order')).toHaveCount(0);
  release();
  await expect(page.getByText('Asha Project', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture Brand', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('confirm-place-order')).toContainText('Generate 1 PO');
});

test('critical shared dialog contains keyboard focus, closes on Escape and restores its trigger', async ({ page }) => {
  await mockSession(page, '/notebook/kitchen');
  await page.route('**/api/followups/notebook/second-floor?**', route => route.fulfill({ json: { rows: [], next_cursor: null } }));
  await page.goto('/notebook/kitchen');
  const trigger = page.getByRole('button', { name: 'New walk-in', exact: true }).first();
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New walk-in', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(0);
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('critical workspace menu supports arrow keys and restores focus without switching floors', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockSession(page, '/customers');
  await page.route('**/api/settings/floors', route => route.fulfill({ json: floors }));
  await page.goto('/customers');
  const trigger = page.getByTestId('floor-switcher');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('The Sanitary Bathroom');
});

test('critical Follow-ups snooze menu keeps keyboard focus and restores its trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockSession(page, '/followups');
  await page.route('**/api/followups/config/assignees', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  await page.route('**/api/customers', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/page?**', route => route.fulfill({ json: {
    items: [{
      id: 'menu-followup', customer_id: 'customer-one', customer_name: 'Menu Customer', customer_tier: 'retail', customer_phone: '9000000000',
      rule_type: 'manual', category: 'general', value: 12000, reason: 'Confirm delivery', reason_factors: [],
      next_action: 'Call customer', next_action_reason: 'Delivery confirmation', suggested_channel: 'call',
      priority_score: 70, priority_level: 'high', due_at: new Date().toISOString(), status: 'open',
      is_automated: false, auto_resolved: false, contact_attempts: 0, tags: [], bucket: 'today',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), assigned_to: 'audit-owner',
    }], page: 1, page_size: 100, has_more: false,
  } }));
  await page.goto('/followups');
  const trigger = page.getByTestId('snooze-menu-followup');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Snooze' });
  const items = menu.getByRole('menuitem');
  await expect(menu).toBeVisible();
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('critical manager assignments recover from an unavailable register without showing an empty state', async ({ page }) => {
  await mockSession(page, '/followup-assignments');
  await page.goto('/followup-assignments');
  await expect(page.getByText("Couldn't load assignments", { exact: true })).toBeVisible();
  await expect(page.getByText('Nothing assigned', { exact: true })).toHaveCount(0);

  const requested: string[] = [];
  await page.route('**/api/followups/assignments', route => {
    requested.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: [{
      id: 'assignment-one', assigned_to: 'audit-owner', assigned_to_name: 'Audit Owner',
      customer_name: 'Asha Project', reason: 'Confirm delivery', category: 'general',
      status: 'open', bucket: 'today', days_pending: 2,
      due_at: '2026-09-13T09:00:00Z', created_at: '2026-09-11T09:00:00Z',
    }] });
  });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('1 assignment', { exact: true })).toBeVisible();
  await expect(page.getByText('Asha Project · Confirm delivery', { exact: true })).toBeVisible();
  expect(requested).toEqual(['/api/followups/assignments']);
});
