import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { mockSalesAnalytics } from './sales-analytics-fixtures';

async function targetSize(control: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  // Chromium returns fractional CSS pixels (for example 43.99994 for 44px).
  // Permit only numerical rounding, never a smaller practical touch target.
  expect(box!.width).toBeGreaterThanOrEqual(44 - 0.001);
  expect(box!.height).toBeGreaterThanOrEqual(44 - 0.001);
}

async function salesFixture(page: Page) {
  await mockSalesAnalytics(page);
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:8096'
    ? route.continue() : route.abort());
});

for (const key of ['Enter', 'Space']) {
  test(`actionable KPI preserves standard link keyboard behavior with ${key}`, async ({ page }) => {
    await salesFixture(page);
    await page.goto('/sales-data');
    const card = page.getByTestId('analytics-kpi-orders');
    await expect(card).toHaveRole('link');
    await card.focus();
    await expect(card).toBeFocused();
    await page.keyboard.press(key);
    if (key === 'Space') {
      await expect(page).not.toHaveURL(/\/sales-data\/records(?:\?|$)/);
      await page.keyboard.press('Enter');
    }
    await expect(page).toHaveURL(/\/sales-data\/records(?:\?|$)/);
    await expect(page.getByRole('heading', { name: 'Supporting records', exact: true })).toBeVisible();
  });
}

test('shell navigation opens catalog with Enter without reloading the document', async ({ page }) => {
  await mockSession(page, '/customers');
  await page.goto('/customers');
  const sentinel = await page.evaluate(() => { (window as any).__responsiveNavigation = 'same-document'; return true; });
  expect(sentinel).toBe(true);
  const nav = page.viewportSize()!.width < 768 ? page.getByTestId('bottom-nav-catalog') : page.getByTestId('nav-catalog');
  await expect(nav).toHaveRole('link');
  await nav.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/catalog$/);
  expect(await page.evaluate(() => (window as any).__responsiveNavigation)).toBe('same-document');
});

test('workspace menu and shell controls retain 44px targets and keyboard focus', async ({ page }) => {
  await mockSession(page, '/customers');
  await page.goto('/customers');
  const floor = page.getByTestId('floor-switcher');
  await targetSize(floor);
  await expect(floor).toHaveAttribute('aria-expanded', 'false');
  await floor.focus();
  await page.keyboard.press('Space');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(floor).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(floor).toHaveAttribute('aria-expanded', 'false');
  await expect(floor).toBeFocused();
  if (page.viewportSize()!.width >= 768) {
    await targetSize(page.getByRole('button', { name: 'Account menu', exact: true }));
    await targetSize(page.getByTestId('nav-catalog'));
  }
  if (page.viewportSize()!.width >= 1366) {
    await targetSize(page.getByTestId('open-palette'));
    const collapse = page.getByTestId('admin-sidebar-collapse-toggle');
    await targetSize(collapse);
    await collapse.click();
    await expect(collapse).toHaveAccessibleName('Expand sidebar');
    await targetSize(collapse);
    await targetSize(page.getByTestId('nav-catalog'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});

test('quotation room controls retain native target sizes on web and open the editor', async ({ page }, info) => {
  await mockSession(page, '/quotations/new');
  await page.goto('/quotations/new');
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  const expand = page.getByTestId('expand-quotation-workspace');
  if (await expand.isVisible()) await expand.click();
  const quotationTab = page.getByTestId('builder-tab-quotation');
  if (await quotationTab.isVisible()) await quotationTab.click();
  const panel = page.getByTestId('builder-quotation-panel-toggle');
  if (await panel.isVisible()) {
    await targetSize(panel);
    await expect(panel).toHaveAttribute('aria-expanded', 'true');
    await panel.focus();
    await page.keyboard.press('Space');
    await expect(panel).toHaveAccessibleName('Show quotation panel');
    await expect(panel).toHaveAttribute('aria-expanded', 'false');
    await targetSize(panel);
    await page.keyboard.press('Space');
    await expect(panel).toHaveAttribute('aria-expanded', 'true');
  }
  await targetSize(page.getByTestId('room-Master Bath'));
  const add = page.getByRole('button', { name: 'Add room', exact: true });
  await targetSize(add);
  await add.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog').last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('room-editor.png') });
});

for (const name of ['Privacy', 'Terms']) {
  test(`sign-in ${name} link opens with Enter and retains validation labels`, async ({ page }, info) => {
    await page.route('**/api/**', route => route.fulfill({ status: 401, json: { detail: 'Fixture signed out' } }));
    await page.goto('/login');
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('alert')).toHaveText('Enter your email or username and password.');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    const link = page.getByRole('link', { name, exact: true });
    await targetSize(link);
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/${name.toLowerCase()}$`));
    await expect(page.getByText('Publication requirement', { exact: true })).toBeVisible();
    const back = page.getByRole('link', { name: 'Back to sign in', exact: true });
    await back.focus();
    await expect(back).toBeInViewport();
    await targetSize(back);
    await page.screenshot({ path: info.outputPath('public-page-bottom.png') });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('form', { name: 'Staff sign-in', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('phone More destinations open with Enter and dismiss the workspace sheet', async ({ page }) => {
  test.skip(page.viewportSize()!.width >= 768, 'More sheet is the phone navigation variant.');
  await mockSession(page, '/customers');
  await page.goto('/customers');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Workspace', exact: true });
  await expect(sheet).toBeVisible();
  const link = sheet.getByRole('link', { name: 'Payments', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/payments$/);
  await expect(sheet).toHaveCount(0);
});

test('dashboard pipeline and follow-up links expose names and keyboard destinations', async ({ page }) => {
  await mockSession(page, '/dashboard', false, { staff: { id: 'audit-manager', email: 'manager@example.test', full_name: 'Audit Manager', role: 'manager', active: true, floor_ids: ['first-floor'] } });
  await page.route('**/api/followups/mission', route => route.fulfill({ json: {
    due_count: 1, revenue_at_risk: 0, revenue_at_risk_short: '0', overdue_payments: 0,
    quotations_expiring_today: 0, critical_count: 0, estimated_minutes: 1, greeting_name: 'Fixture',
  } }));
  await page.route('**/api/dashboard/stats', route => route.fulfill({ json: {
    revenue_month: 1000, open_pipeline: 2000, pending_approval: 1, quotes_this_month: 1,
  } }));
  await page.route('**/api/purchases/shortages?**', route => route.fulfill({ json: {
    items: [{ id: 'fixture-shortage', customer_name: 'Fixture customer', name: 'Fixture basin', shortage_qty: 1 }],
  } }));
  for (const [name, destination] of [
    ['View all quotations', '/quotations'], ['All follow-ups', '/followups'],
    ['1 quotation waiting for approval', '/quotations'], ['1 customer awaiting reorder after a transfer', '/purchases'],
  ]) {
    await page.goto('/dashboard');
    const link = page.getByRole('link', { name, exact: true });
    await targetSize(link);
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
  }
});

test('quotation product failures do not report zero products and a successful empty result reports zero', async ({ page }) => {
  await mockSession(page, '/quotations/new', false);
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  let failed = true;
  await page.route('**/api/products/families?**', route => failed
    ? route.fulfill({ status: 503, json: { detail: 'Fixture product query unavailable' } })
    : route.fulfill({ json: { total: 0, items: [] } }));
  await page.goto('/quotations/new');
  await expect(page.getByText('Products unavailable', { exact: true })).toBeVisible();
  const count = page.getByTestId('explorer-product-count');
  await expect(count).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No products available', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry catalog', exact: true })).toBeVisible();
  await expect(count).toHaveText('· 0 products');
});
