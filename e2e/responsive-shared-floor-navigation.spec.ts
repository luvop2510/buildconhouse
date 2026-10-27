import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const kitchenStages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
const kitchenLabels = ['Lead', 'Visit', 'CAD File', 'Design', 'Quotation', 'Order', 'Production', 'Installation', 'Completed'];
async function kitchenReads(page: import('@playwright/test').Page) {
  await page.route('**/api/kitchen-projects**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/assignees') ? { rows: [] } : path.endsWith('/dashboard') ? { configured: true, stage_counts: Object.fromEntries(kitchenStages.map(stage => [stage, 0])), stage_customer_counts: Object.fromEntries(kitchenStages.map(stage => [stage, 0])), pending_approvals: 0, completion_overdue_projects: 0, on_hold_projects: 0 } : path.endsWith('/configuration') ? { version: 1, department_manager_user_ids: [], files: { max_bytes: 786432, allowed_types: [] } } : { rows: [], total: 0, page: 1, limit: 25 } });
  });
}
for (const [floor, label] of [['ground-floor', 'Ground Floor'], ['first-floor', 'The Sanitary Bathroom'], ['second-floor', 'Kitchen Floor'], ['third-floor', 'Furniture Floor']] as const) {
  test(`critical ${floor} exposes only its supported workspaces on every navigation surface`, async ({ page }) => {
    await mockSession(page, '/followups', false);
    await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floor);
    await kitchenReads(page);
    await page.route('**/api/followups/page?**', route => {
      expect(route.request().headers()['x-floor-id']).toBe(floor);
      return route.fulfill({ json: { items: [], page: 1, page_size: 100, has_more: false } });
    });
    await page.goto('/followups');
    await expect(page.getByTestId('floor-switcher')).toHaveAccessibleName(`Switch workspace. Current workspace: ${label}`);
    const kitchen = floor === 'second-floor';
    if (kitchen) {
      await expect(page).toHaveURL(/\/kitchen$/);
      const activeStage = page.getByTestId(page.viewportSize()!.width < 768 ? 'bottom-nav-kitchen-dashboard' : 'nav-kitchen-dashboard');
      await expect(activeStage).toHaveAttribute('aria-current', 'page');
    }
    const labels = new Set(await page.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('aria-label'))));
    const more = page.getByRole('button', { name: kitchen ? 'All stages' : 'More', exact: true });
    if (await more.isVisible()) {
      await more.click();
      await expect(page.getByRole('dialog', { name: kitchen ? 'Kitchen stages' : 'Workspace', exact: true })).toBeVisible();
      for (const label of await page.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('aria-label')))) labels.add(label);
    }
    if (kitchen) {
      expect(labels.has('Kitchen dashboard'), 'Kitchen navigation includes the central dashboard').toBe(true);
      await expect(page.getByTestId('kitchen-dashboard-stages')).toBeVisible();
      for (const [index, name] of kitchenLabels.entries()) {
        expect(labels.has(name), `Kitchen navigation includes ${name}`).toBe(true);
        await expect(page.getByTestId(`kitchen-dashboard-stage-${kitchenStages[index]}`)).toHaveCount(1);
        await expect(page.locator(`a[href="/kitchen/stages/${kitchenStages[index]}"]`)).toHaveCount(2);
      }
      for (const retired of ['Overview', 'Projects', 'Workflow', 'Sales Data', 'Customers', 'Walk-ins', 'Follow-ups', 'Payments', 'Team', 'Settings']) expect(labels.has(retired), `${retired} is not a Kitchen page`).toBe(false);
    } else await expect(page.locator('a[href="/kitchen/stages/lead"]')).toHaveCount(0);
    expect(labels.has('Walk-ins')).toBe(!kitchen);
    expect(labels.has('Follow-ups')).toBe(!kitchen);
    expect(labels.has('Purchases')).toBe(floor === 'first-floor');
    expect(labels.has('Catalog')).toBe(['first-floor', 'ground-floor'].includes(floor));
    expect(labels.has('RNB quotations')).toBe(floor === 'third-floor');
    expect([...labels].some(label => /Kitchen lead|Furniture lead|Quotation Follow-up/.test(label || ''))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

for (const [floor, path] of [['second-floor', '/notebook/furniture'], ['third-floor', '/notebook/kitchen'], ['third-floor', '/notebook/kitchen/quotation-follow-up'], ['second-floor', '/notebook/furniture/quotation']] as const) {
  test(`critical retired ${path} preserves ${floor} instead of opening another floor`, async ({ page }) => {
    await mockSession(page, path, false);
    await kitchenReads(page);
    await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floor);
    let retiredReads = 0;
    await page.route('**/api/followups/notebook/**', route => { retiredReads++; return route.fulfill({ json: { rows: [], next_cursor: null } }); });
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${floor === 'second-floor' ? '/kitchen' : path.includes('/quotation') ? '/followups' : '/walkins'}$`));
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor')!))).toBe(floor);
    expect(retiredReads).toBe(0);
  });
}

for (const floor of ['ground-floor', 'second-floor', 'third-floor']) {
  for (const path of ['/purchases', '/purchases-completed', ...(floor === 'ground-floor' ? [] : ['/catalog'])]) {
    test(`critical ${floor} blocks a direct ${path} URL before business reads`, async ({ page }) => {
      await mockSession(page, path, false);
      await kitchenReads(page);
      await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floor);
      let businessReads = 0;
      await page.route(/\/api\/(purchases|products|brands|categories)(?:\/|\?|$)/, route => { businessReads++; return route.fulfill({ json: [] }); });
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${floor === 'ground-floor' ? '/tiles' : floor === 'second-floor' ? '/kitchen' : '/walkins'}$`));
      expect(businessReads).toBe(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor')!))).toBe(floor);
    });
  }
}

for (const [sourceFloor, sourceName] of [['first-floor', 'The Sanitary Bathroom'], ['ground-floor', 'Ground Floor']] as const) {
  test(`critical switching ${sourceFloor} follow-ups to Furniture clears prior customer data`, async ({ page }) => {
    await mockSession(page, '/followups', false);
    await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), sourceFloor);
    const reads: string[] = [];
    await page.route('**/api/followups/page?**', route => {
      const floor = route.request().headers()['x-floor-id']; reads.push(floor);
      const now = new Date().toISOString();
      return route.fulfill({ json: { items: [{ id: floor, floor_id: floor, customer_id: floor,
        customer_name: `${floor} exclusive customer`, customer_phone: '9000000000', customer_tier: 'retail',
        rule_type: 'manual', category: 'general', value: 100, reason: 'Check interest', next_action: 'Call customer',
        reason_factors: [], suggested_channel: 'call', priority_score: 60, priority_level: 'high', due_at: now,
        status: 'open', is_automated: false, auto_resolved: false, contact_attempts: 0, tags: [], bucket: 'today',
        created_at: now, updated_at: now }], page: 1, page_size: 100, has_more: false } });
    });
    await page.goto('/followups');
    await expect(page.getByText(`${sourceFloor} exclusive customer`, { exact: true })).toBeVisible();
    await page.getByTestId('followups-search').fill('exclusive');
    if (page.viewportSize()!.width < 768) await expect(page.getByTestId('floor-switcher')).toBeHidden();
    await page.getByTestId('followups-search').blur();
    await page.getByTestId('floor-switcher').click();
    await page.getByRole('menuitem', { name: 'Furniture Floor', exact: true }).click();
    await expect(page.getByText('third-floor exclusive customer', { exact: true })).toBeVisible();
    await expect(page.getByText(`${sourceFloor} exclusive customer`, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('followups-search')).toHaveValue('');
    await expect(page).toHaveURL(/\/followups$/);
    expect(reads.at(-1)).toBe('third-floor');
    await page.getByTestId('floor-switcher').click();
    await page.getByRole('menuitem', { name: sourceName, exact: true }).click();
    await expect(page.getByText(`${sourceFloor} exclusive customer`, { exact: true })).toBeVisible();
    await expect(page.getByText('third-floor exclusive customer', { exact: true })).toHaveCount(0);
    expect(reads.at(-1)).toBe(sourceFloor);
  });
}

for (const floor of ['ground-floor', 'second-floor', 'third-floor']) {
  test(`critical ${floor} customer profile avoids sanitary purchasing requests`, async ({ page }) => {
    await mockSession(page, '/customers/scoped-client', false);
    await kitchenReads(page);
    await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floor);
    const forbidden: string[] = [];
    await page.route(/\/api\/(purchases|purchase-orders|godown-stock)(?:\/|\?|$)/, route => {
      forbidden.push(route.request().url());
      return route.fulfill({ status: 403, json: { detail: 'Sanitary-only service' } });
    });
    await page.route('**/api/customers/scoped-client?**', route => route.fulfill({ json: { id: 'scoped-client', name: 'Scoped Buyer', company: 'Scoped Buyer', phone: '9000000000', tier: 'retail' } }));
    await page.route('**/api/quotations?customer_id=**', route => route.fulfill({ json: [] }));
    await page.route('**/api/activity/customer/scoped-client', route => route.fulfill({ json: [] }));
    await page.goto('/customers/scoped-client');
    if (floor === 'second-floor') {
      await expect(page).toHaveURL(/\/kitchen$/);
      expect(forbidden).toEqual([]);
      return;
    }
    await expect(page.getByText('Scoped Buyer', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
    await expect(page.getByText('Some related records could not be loaded. Counts may be incomplete.', { exact: true })).toHaveCount(0);
    if (floor === 'ground-floor') {
      await expect(page.getByRole('tab', { name: 'Tile Orders', exact: true })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'PO Final', exact: true })).toHaveCount(0);
    } else await expect(page.getByRole('tab', { name: 'Purchases', exact: true })).toHaveCount(0);
    expect(forbidden).toEqual([]);
  });
}

test('critical Ground dashboard avoids sanitary purchasing requests', async ({ page }) => {
  await mockSession(page, '/dashboard', false);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('ground-floor')));
  const forbidden: string[] = [];
  await page.route('**/api/purchases/**', route => { forbidden.push(route.request().url()); return route.fulfill({ status: 403, json: { detail: 'Sanitary-only service' } }); });
  await page.route('**/api/dashboard/stats', route => route.fulfill({ json: { revenue_month: 0, open_pipeline: 0, pending_approval: 0, quotes_this_month: 0 } }));
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Purchases', exact: true })).toHaveCount(0);
  expect(forbidden).toEqual([]);
});

test('critical Ground catalog product avoids sanitary purchasing pipeline requests', async ({ page }) => {
  await mockSession(page, '/catalog/scoped-product', false);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('ground-floor')));
  const forbidden: string[] = [];
  await page.route('**/api/purchases/**', route => { forbidden.push(route.request().url()); return route.fulfill({ status: 403, json: { detail: 'Sanitary-only service' } }); });
  await page.route('**/api/products/scoped-product', route => route.fulfill({ json: { id: 'scoped-product', name: 'Scoped Product', sku: 'SCOPED', floor_id: 'ground-floor', price: 100, mrp: 100, brand_id: 'example', category_id: 'tiles', images: [], tags: [], stock: 0 } }));
  await page.route('**/api/products/scoped-product/alternates?**', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/brands', route => route.fulfill({ json: [] }));
  await page.goto('/catalog/scoped-product');
  await expect(page.getByText('Scoped Product', { exact: true }).first()).toBeVisible();
  expect(forbidden).toEqual([]);
});
