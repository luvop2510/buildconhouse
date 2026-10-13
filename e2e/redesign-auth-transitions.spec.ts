import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

test('critical static sign-in waits for hydration before accepting credentials', async ({ page }) => {
  await mockSession(page, '/login', false, { signedIn: false });
  await page.route('**/api/auth/login', route => {
    expect(route.request().postDataJSON()).toEqual({ email: 'JK PATEL', password: 'OwnerAssigned!2026' });
    return route.fulfill({ json: { access_token: 'fixture-only-staff', user: {
      id: 'hydrated-owner', full_name: 'Hydrated Owner', role: 'owner', active: true, floor_ids: [],
    } } });
  });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/_expo/static/js/web/entry-*.js', async route => {
    await pending;
    await route.continue();
  });
  try {
    await page.goto('/login', { waitUntil: 'commit' });
    const username = page.getByTestId('login-email');
    const password = page.getByTestId('login-password');
    await expect(username).toBeVisible();
    // React Native Web implements editable=false with the HTML readonly
    // attribute. Assert the user cannot enter text before handlers attach.
    await expect(username).not.toBeEditable();
    await expect(password).not.toBeEditable();
    await expect(page.getByTestId('login-submit')).toBeDisabled();
    release();
    await username.fill('JK PATEL');
    await password.fill('OwnerAssigned!2026');
    await expect(username).toHaveValue('JK PATEL');
    await expect(password).toHaveValue('OwnerAssigned!2026');
    await expect(page.getByTestId('login-submit')).toBeEnabled();
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Hydrated\.$/ })).toBeVisible();
  } finally {
    release();
  }
});

for (const kind of ['staff', 'customer'] as const) {
  test(`critical a newer ${kind} sign-in survives delayed startup identity hydration`, async ({ page }) => {
    await mockSession(page, '/login', false);
    let releaseIdentity!: () => void;
    let identityStarted!: () => void;
    let identityFinished!: () => void;
    const held = new Promise<void>(resolve => { releaseIdentity = resolve; });
    const started = new Promise<void>(resolve => { identityStarted = resolve; });
    const finished = new Promise<void>(resolve => { identityFinished = resolve; });
    await page.route('**/api/auth/me', async route => {
      identityStarted();
      await held;
      // The old fetch may have been cancelled by the newer login.
      try {
        await route.fulfill({ json: { id: 'old-owner', email: 'old@example.test', full_name: 'Old Owner', role: 'owner', active: true, floor_ids: floors.map(floor => floor.id) } }).catch(() => {});
      } finally { identityFinished(); }
    });
    const endpoint = kind === 'staff' ? 'login' : 'customer/login';
    await page.route(`**/api/auth/${endpoint}`, route => route.fulfill({ json: kind === 'staff'
      ? { access_token: 'fixture-only-staff', user: { id: 'new-owner', email: 'new@example.test', full_name: 'New Owner', role: 'owner', active: true, floor_ids: floors.map(floor => floor.id) } }
      : { access_token: 'fixture-only-customer', customer: { id: 'new-customer', email: 'new@example.test', name: 'New Customer', tier: 'retail', portal_enabled: true } }
    }));
    try {
      await page.goto('/login');
      await started;
      if (kind === 'customer') await page.getByRole('tab', { name: 'Customer portal' }).click();
      await page.getByTestId('login-email').fill('new@example.test');
      await page.getByTestId('login-password').fill('fixture-only-password');
      await page.getByTestId('login-submit').click();
      await expect(page).toHaveURL(kind === 'staff' ? /\/dashboard$/ : /\/home$/);
      releaseIdentity();
      await finished;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (kind === 'staff') {
        await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), New\.$/ })).toBeVisible();
        await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Old\.$/ })).toHaveCount(0);
      } else {
        await expect(page.getByText('New Customer', { exact: true }).first()).toBeVisible();
      }
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.jwt.kind') || 'null'))).toBe(kind);
      await expect(page.getByTestId('login-submit')).toHaveCount(0);
      await expect(page).toHaveURL(kind === 'staff' ? /\/dashboard$/ : /\/home$/);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.jwt.kind') || 'null'))).toBe(kind);
    } finally {
      releaseIdentity();
    }
  });
}


for (const role of ['owner', 'worker']) {
  test(`critical ${role} signs in with owner-set password and an obsolete force-change flag`, async ({ page }) => {
    await mockSession(page, '/login', false, { signedIn: false });
    const person = { id: `password-${role}`, email: 'fixture@example.test', login_id: role === 'owner' ? 'JK PATEL' : 'NEW WORKER', full_name: 'Password Account', role, active: true, floor_ids: role === 'owner' ? [] : ['first-floor'], must_change_password: true, custom_access: role !== 'owner' };
    await page.route('**/api/auth/login', route => {
      expect(route.request().postDataJSON()).toEqual({ email: person.login_id, password: 'OwnerAssigned!2026' });
      return route.fulfill({ json: { access_token: 'fixture-only-staff', user: person } });
    });
    await page.route('**/api/settings/access-grants/me', route => route.fulfill({ json: { grants: [] } }));
    await page.goto('/login');
    await page.getByTestId('login-email').fill(person.login_id);
    await page.getByTestId('login-password').fill('OwnerAssigned!2026');
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(role === 'owner' ? /dashboard$/ : /access$/);
    await expect(page.getByTestId('force-change-current')).toHaveCount(0);
  });
}

test('critical customer invite still requires its separate first-sign-in password change', async ({ page }) => {
  await mockSession(page, '/home', false);
  await page.route('**/api/auth/customer/me', route => route.fulfill({ json: { id: 'invite-customer', email: 'customer@example.test', name: 'Invite Customer', tier: 'retail', portal_enabled: true, must_change_password: true } }));
  let payload: unknown;
  await page.route('**/api/auth/customer/change-password', route => { payload = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }); });
  await page.goto('/home');
  await expect(page).toHaveURL(/set-new-password$/);
  await page.getByTestId('force-change-current').fill('CustomerInvite!2026');
  await page.getByTestId('force-change-new').fill('12345');
  await page.getByTestId('force-change-confirm').fill('12345');
  await page.getByTestId('force-change-submit').click();
  await expect(page.getByText('New password must be at least 6 characters', { exact: true })).toBeVisible();
  expect(payload).toBeUndefined();
  await page.getByTestId('force-change-new').fill('123456');
  await page.getByTestId('force-change-confirm').fill('123456');
  await page.getByTestId('force-change-submit').click();
  await expect(page).toHaveURL(/home$/);
  expect(payload).toEqual({ current_password: 'CustomerInvite!2026', new_password: '123456', confirm_password: '123456' });
});


test('critical transient startup identity failure preserves the saved session and reload recovers', async ({ page }) => {
  await mockSession(page, '/dashboard', false);
  let unavailable = true;
  await page.route('**/api/auth/me', route => route.fulfill(unavailable
    ? { status: 503, json: { detail: 'Temporary identity transport failure' } }
    : { json: { id: 'recovered-owner', email: 'owner@example.test', full_name: 'Recovered Owner', role: 'owner', active: true, floor_ids: [] } }));
  await page.goto('/dashboard');
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Recovered\.$/ })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('forge.jwt.kind') || 'null'))).toBe('staff');
  unavailable = false;
  await page.reload();
  await expect(page).toHaveURL(/dashboard$/);
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Recovered\.$/ })).toBeVisible();
});
