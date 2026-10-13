import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';
import { readFileSync } from 'node:fs';

for (const [path, destination] of [['/reports', '/dashboard'], ['/purchase-orders', '/purchases'], ['/notebook/kitchen/followups', '/notebook/kitchen'], ['/notebook/furniture/quotation', '/notebook/furniture/quotation-follow-up']]) {
  test(`critical compatibility URL ${path} reaches its existing workspace`, async ({ page }) => {
    await mockSession(page, path);
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  });
}

test('critical legacy furniture URL waits for authorized floors before opening quotation follow-up', async ({ page }) => {
  await mockSession(page, '/notebook/furniture/quotation');
  let releaseFloorAccess!: () => void;
  const pendingFloorAccess = new Promise<void>(resolve => { releaseFloorAccess = resolve; });
  await page.route('**/api/settings/floor-access', async route => {
    await pendingFloorAccess;
    await route.fulfill({ json: { all_floors: true, floors, floor_ids: floors.map(floor => floor.id) } });
  });
  let notebookReads = 0;
  await page.route('**/api/followups/notebook/**', route => {
    notebookReads += 1;
    return route.fulfill({ json: { rows: [], next_cursor: null } });
  });
  await page.goto('/notebook/furniture/quotation');
  await expect(page.getByTestId('floor-access-loading')).toBeVisible();
  expect(notebookReads).toBe(0);
  releaseFloorAccess();
  await expect(page).toHaveURL(/\/notebook\/furniture\/quotation-follow-up$/);
  await expect(page.getByRole('heading', { name: 'Furniture Floor Quotation follow-ups', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Switch workspace\. Current workspace: Furniture/ })).toBeVisible();
});

test('critical cold quotation reload retains its query while authorized floors are delayed', async ({ page }) => {
  await mockSession(page, '/quotations/new', false);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/settings/floor-access', async route => {
    await pending;
    await route.fulfill({ json: { all_floors: true, floors, floor_ids: floors.map(floor => floor.id) } });
  });
  let businessReads = 0;
  for (const path of ['brands', 'categories', 'products/families']) {
    await page.route(`**/api/${path}**`, route => {
      businessReads++;
      return route.fulfill({ json: path === 'products/families' ? { total: 0, items: [] } : [] });
    });
  }
  await page.goto('/quotations/new?catalogEntryId=retained-entry');
  await expect(page.getByTestId('floor-access-loading')).toBeVisible();
  expect(businessReads).toBe(0);
  await page.reload();
  await expect(page.getByTestId('floor-access-loading')).toBeVisible();
  expect(businessReads).toBe(0);
  release();
  await expect(page).toHaveURL(/\/quotations\/new\?catalogEntryId=retained-entry$/);
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  await expect.poll(() => businessReads).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('forge.pending-initial-route'))).toBeNull();
});

test('critical entry route sends staff and customers to separate workspaces', async ({ page }) => {
  await mockSession(page, '/dashboard');
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard$/);
  await mockSession(page, '/home');
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);
});

test('critical sign-in identifies staff and customer accounts and submits a labeled form', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 401, json: { detail: 'Not signed in' } }));
  await page.goto('/login');
  await expect(page.getByRole('form', { name: 'Staff sign-in' })).toBeVisible();
  await page.getByTestId('login-mode-customer').click();
  await expect(page.getByRole('form', { name: 'Customer sign-in' })).toBeVisible();
  await expect(page.getByTestId('login-mode-customer')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('alert')).toContainText('Enter your email and password');
  await page.getByTestId('login-mode-staff').click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('critical company settings distinguish saved, changed, failed and discarded values', async ({ page }) => {
  await mockSession(page, '/settings-company');
  const company = { name: 'BuildCon House', tagline: '', phone: '9000000000', email: 'team@example.test', address: '', gstin: '', logo_base64: null };
  let writes = 0;
  await page.route('**/api/settings/company', route => {
    if (route.request().method() === 'PUT') {
      writes += 1;
      return route.fulfill({ status: 503, json: { detail: 'Save temporarily unavailable' } });
    }
    return route.fulfill({ json: company });
  });
  await page.goto('/settings-company');
  await expect(page.getByTestId('save-company-btn')).toBeDisabled();
  await page.getByTestId('company-name-input').fill('BuildCon House revised');
  await expect(page.getByText('You have unsaved changes', { exact: true })).toBeVisible();
  await page.getByTestId('save-company-btn').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('company-name-input')).toHaveValue('BuildCon House revised');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByTestId('company-name-input')).toHaveValue(company.name);
  expect(writes).toBe(1);
});

test('critical image-only company logo selection saves the chosen image through the system picker', async ({ page }) => {
  await mockSession(page, '/settings-company');
  let company = { name: 'BuildCon House', tagline: '', phone: '', email: '', address: '', gstin: '', logo_base64: null as string | null };
  let writes = 0;
  await page.route('**/api/settings/company', route => {
    if (route.request().method() === 'PUT') {
      writes += 1;
      company = route.request().postDataJSON();
    }
    return route.fulfill({ json: company });
  });
  await page.goto('/settings-company');
  await expect(page.getByTestId('save-company-btn')).toBeDisabled();
  const image = readFileSync('assets/images/favicon.png');
  const chosen = page.waitForEvent('filechooser');
  await page.getByTestId('pick-logo-btn').click();
  await (await chosen).setFiles({ name: 'company-logo.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByTestId('save-company-btn')).toBeEnabled();
  await page.getByTestId('save-company-btn').click();
  await expect(page.getByTestId('save-company-btn')).toBeDisabled();
  expect(writes).toBe(1);
  expect(company.logo_base64).toBe(`data:image/png;base64,${image.toString('base64')}`);
});

test('critical notification rules recover from failure without inventing an empty result', async ({ page }) => {
  await mockSession(page, '/settings-notifications');
  await page.goto('/settings-notifications');
  await expect(page.getByText('Could not load follow-up rules', { exact: true })).toBeVisible();
  await page.route('**/api/followups/config/rules', route => route.fulfill({ json: [] }));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No follow-up rules configured', { exact: true })).toBeVisible();
});

test('critical analytics drilldown preserves period and removes an error after retry', async ({ page }) => {
  await mockSession(page, '/sales-data/brands/audit-brand');
  const requests: string[] = [];
  let fail = true;
  await page.route('**/api/executive-analytics/brands/audit-brand?**', route => {
    requests.push(route.request().url());
    return fail ? route.fulfill({ status: 503, json: { detail: 'Brand temporarily unavailable' } }) : route.fulfill({ json: {
      brand: { name: 'Audit Brand' }, kpis: { revenue: 1200, orders: 1, aov: 1200 }, trend: [], products: [], customers: [], salespeople: [], referrals: [],
    } });
  });
  await page.goto('/sales-data/brands/audit-brand?preset=year&floorId=ground-floor');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('brand-detail-revenue')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  expect(new URL(requests.at(-1)!).searchParams.get('preset')).toBe('year');
  expect(new URL(requests.at(-1)!).searchParams.get('floor_id')).toBe('ground-floor');
});

test('critical customer can find a shared document without changing its data', async ({ page }) => {
  await mockSession(page, '/quotes');
  await page.route('**/api/portal/quotations', route => route.fulfill({ json: [
    { id: 'one', number: 'Q-101', status: 'draft', grand_total: 100, created_at: '2026-09-01T00:00:00Z' },
    { id: 'two', number: 'Q-102', status: 'confirmed', grand_total: 200, created_at: '2026-09-02T00:00:00Z' },
  ] }));
  await page.goto('/quotes');
  await page.getByTestId('portal-quote-search').fill('Q-102');
  await expect(page.getByTestId('quote-row-two')).toBeVisible();
  await expect(page.getByTestId('quote-row-one')).toHaveCount(0);
  await page.getByTestId('portal-quote-search').fill('missing');
  await expect(page.getByText('No matching quotations', { exact: true })).toBeVisible();
});

for (const [profile, role, route, forbidden] of [
  ['ground_tile_quotations_followups', 'sales', '/tiles', 'Payments'],
  ['ground_payments_dispatches', 'accounts', '/payments', 'Follow-ups'],
  ['sanitary_quotations_followups', 'sales', '/quotations', 'Purchases'],
  ['sanitary_purchases', 'purchase', '/purchases', 'Payments'],
]) {
  test(`critical ${profile} navigation retains its restricted workspace`, async ({ page }) => {
    await mockSession(page, route);
    const floor = profile.startsWith('ground') ? 'ground-floor' : 'first-floor';
    await page.route('**/api/auth/me', r => r.fulfill({ json: { id: 'restricted', email: 'fixture@example.test', full_name: 'Showroom staff', role, active: true, floor_ids: [floor], access_profile: profile } }));
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(route + '$'));
    await expect(page.getByRole('link', { name: forbidden, exact: true })).toHaveCount(0);
    const more = page.getByRole('button', { name: 'More', exact: true });
    if (await more.isVisible()) {
      await more.click();
      await expect(page.getByRole('dialog', { name: 'Workspace', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: forbidden, exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });
}

test('critical owner with a legacy password flag reaches the workspace and changes their own password', async ({ page }) => {
  await mockSession(page, '/dashboard');
  await page.route('**/api/auth/me', r => r.fulfill({ json: { id: 'audit-owner', email: 'owner@example.test', full_name: 'Audit Owner', role: 'owner', active: true, floor_ids: ['first-floor'], must_change_password: true } }));
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/dashboard$/);
  await expect(page.getByTestId('force-change-current')).toHaveCount(0);
  await page.goto('/settings-password');
  await page.getByTestId('current-password-input').fill('OwnerInitial!2026');
  await page.getByTestId('new-password-input').fill('OwnerReplacement!2026');
  await page.getByTestId('confirm-password-input').fill('OwnerReplacement!2026');
  let payload: unknown;
  await page.route('**/api/auth/change-password', r => { payload = r.request().postDataJSON(); return r.fulfill({ json: { ok: true } }); });
  await page.getByTestId('save-password-btn').click();
  await expect(page).toHaveURL(/settings$/);
  await expect(page.getByTestId('save-password-btn')).toHaveCount(0);
  expect(payload).toEqual({ current_password: 'OwnerInitial!2026', new_password: 'OwnerReplacement!2026', confirm_password: 'OwnerReplacement!2026' });
});

test('critical owner password changes entered through Settings return to the account page', async ({ page }) => {
  await mockSession(page, '/settings', false);
  let payload: unknown;
  await page.route('**/api/auth/change-password', route => {
    payload = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/settings');
  await page.getByTestId('settings-nav-password').click();
  await expect(page).toHaveURL(/settings-password$/);
  await page.getByTestId('current-password-input').fill('OwnerInitial!2026');
  await page.getByTestId('new-password-input').fill('OwnerReplacement!2026');
  await page.getByTestId('confirm-password-input').fill('OwnerReplacement!2026');
  await page.getByTestId('save-password-btn').click();
  await expect(page).toHaveURL(/settings$/);
  await expect(page.getByTestId('settings-nav-password')).toBeVisible();
  await expect(page.getByTestId('save-password-btn')).toHaveCount(0);
  expect(payload).toEqual({ current_password: 'OwnerInitial!2026', new_password: 'OwnerReplacement!2026', confirm_password: 'OwnerReplacement!2026' });
});

test('critical expired sessions return to sign-in without rendering protected data', async ({ page }) => {
  await mockSession(page, '/customers');
  await page.route('**/api/auth/me', r => r.fulfill({ status: 401, json: { detail: 'Session expired' } }));
  await page.goto('/customers');
  await expect(page).toHaveURL(/login/);
  await expect(page.getByRole('form', { name: 'Staff sign-in' })).toBeVisible();
});
