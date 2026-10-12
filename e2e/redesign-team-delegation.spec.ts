import { expect, test, type Page } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

const actions = ['view', 'create', 'update', 'delete', 'export'];
const catalog = {
  resources: [
    { key: 'payments', label: 'Payments', description: 'Orders and payment ledger.', actions, floor_ids: floors.map(floor => floor.id) },
    { key: 'catalog', label: 'Catalog', description: 'Product catalog.', actions: ['view', 'update', 'export'], floor_ids: floors.map(floor => floor.id) },
    { key: 'tiles', label: 'Tile quotations', description: 'Tile selection and quotations.', actions: ['view', 'create', 'update', 'export'], floor_ids: ['ground-floor'] },
  ],
  action_descriptions: { view: 'Open this page and read records.', create: 'Add new records.', update: 'Change existing records.', delete: 'Remove existing records.', export: 'Download or share documents.' },
};
const member = { id: 'test-worker', full_name: 'Test Worker', email: 'worker@example.test', role: 'worker', team_role: 'Ground Floor Sales', active: true, floor_ids: ['ground-floor', 'first-floor'], custom_access: true };
const switchFor = (page: Page, id: string) => page.getByTestId(id).getByRole('switch');
const originalGrants = [{ resource: 'payments', floor_id: 'ground-floor', actions: ['view'] }];

async function teamFixture(page: Page, catalogResponse: () => unknown = () => catalog, existingRole = member.role) {
  await mockSession(page, '/team');
  const writes: { path: string; method: string; body: Record<string, any> }[] = [];
  const state = { members: [{ ...member, role: existingRole }] as Record<string, any>[], failSave: false, failGrants: false, floorIds: [...member.floor_ids], grants: [...originalGrants] };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path.startsWith('/api/team')) {
      writes.push({ path, method: request.method(), body: request.postDataJSON() || {} });
      if (state.failSave) return route.fulfill({ status: 503, json: { detail: 'Save temporarily unavailable' } });
      if (path.endsWith("/reset-password")) return route.fulfill({ json: { delivery_method: "manual", password: request.postDataJSON()?.new_password || "GeneratedOwner!2026", expires_at: null } });
      if (request.method() === "DELETE") { state.members = state.members.filter(item => item.id !== path.split('/').pop()); return route.fulfill({ json: { ok: true } }); }
      const result = { ...member, ...request.postDataJSON(), id: request.method() === 'POST' ? 'created-worker' : path.split('/').pop() };
      if (request.method() === 'POST') state.members.push(result);
      else state.members = state.members.map(item => item.id === result.id ? { ...item, ...request.postDataJSON() } : item);
      return route.fulfill({ json: result });
    }
    if (path === '/api/team') return route.fulfill({ json: state.members });
    if (path === '/api/settings/floors') return route.fulfill({ json: floors });
    if (path === '/api/settings/access-grants/resources') return route.fulfill({ json: catalogResponse() });
    if (path === '/api/settings/access-grants/test-worker' || path === '/api/settings/access-grants/created-worker') return state.failGrants ? route.fulfill({ status: 503, json: { detail: 'Access temporarily unavailable' } }) : route.fulfill({ json: { floor_ids: state.floorIds, grants: state.grants } });
    if (path === '/api/roles') return route.fulfill({ json: [{ role: 'owner', label: 'Owner', level: 8 }, { role: 'admin', label: 'Admin', level: 7 }, { role: 'manager', label: 'Manager', level: 6 }, { role: 'sales', label: 'Sales', level: 4 }, { role: 'worker', label: 'Worker', level: 1 }] });
    return route.fallback();
  });
  await page.goto('/team');
  await expect(page.getByTestId('team-row-test-worker')).toBeVisible();
  return { writes, state };
}

async function fillNewMember(page: Page) {
  await page.getByTestId('team-add-btn').click();
  await page.getByTestId('add-staff-name').fill('New Worker');
  await page.getByTestId('add-staff-email').fill('new-worker@example.test');
  await page.getByTestId('add-staff-password').fill('NewWorker!2026');
  await page.getByTestId('add-staff-username').fill('NEW WORKER');
  await page.getByTestId('add-staff-team-role').fill('Ground Floor Sales');
  await expect(page.getByTestId('floor-delegation-editor')).toBeVisible();
  await expect(page.getByTestId('add-staff-role-worker')).toHaveText('Delegated staff');
  for (const role of ['admin', 'manager', 'sales', 'purchase', 'accounts', 'warehouse']) await expect(page.getByTestId(`add-staff-role-${role}`)).toHaveCount(0);
}

// These browser journeys exercise the release export and intercept every API
// request. No production accounts, credentials or database mutations are used.
test('critical team delegation: multiple floors, pages and actions save in one create', async ({ page }) => {
  const { writes } = await teamFixture(page);
  await fillNewMember(page);
  await expect(page.getByTestId('floor-pages-ground-floor')).toHaveCount(0);
  await switchFor(page, 'floor-toggle-ground-floor').check();
  await switchFor(page, 'page-toggle-ground-floor-payments').check();
  await expect(switchFor(page, 'action-toggle-ground-floor-payments-view')).toBeDisabled();
  await expect(page.getByText('Open this page and read records.', { exact: true }).first()).toBeVisible();
  await switchFor(page, 'action-toggle-ground-floor-payments-create').check();
  await switchFor(page, 'page-toggle-ground-floor-tiles').check();
  await switchFor(page, 'floor-toggle-first-floor').check();
  await expect(switchFor(page, 'page-toggle-first-floor-tiles')).toHaveCount(0);
  await switchFor(page, 'page-toggle-first-floor-catalog').check();
  await expect(page.getByTestId('delegation-summary')).toHaveText('2 floors · 3 pages enabled');
  await page.getByTestId('add-staff-save').click();
  await expect(page.getByTestId('add-staff-sheet')).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ role: 'worker', custom_access: true, access_profile: null, floor_ids: ['ground-floor', 'first-floor'], team_role: 'Ground Floor Sales', login_id: 'NEW WORKER' });
  expect(writes[0].body.access_grants).toEqual([
    { resource: 'payments', floor_id: 'ground-floor', actions: ['view', 'create'] },
    { resource: 'tiles', floor_id: 'ground-floor', actions: ['view'] },
    { resource: 'catalog', floor_id: 'first-floor', actions: ['view'] },
  ]);
});

test('critical team delegation: a new account starts with every floor off and saves explicit no access', async ({ page }) => {
  const { writes } = await teamFixture(page);
  await fillNewMember(page);
  for (const floor of floors) await expect(switchFor(page, `floor-toggle-${floor.id}`)).not.toBeChecked();
  await expect(page.getByTestId('delegation-summary')).toHaveText('0 floors · 0 pages enabled');
  await page.getByTestId('add-staff-save').click();
  await expect(page.getByTestId('add-staff-sheet')).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ custom_access: true, access_profile: null, floor_ids: [], access_grants: [] });
});

test('critical team delegation: disabling a floor clears its pages and starts blank when reenabled', async ({ page }) => {
  const { writes } = await teamFixture(page);
  await fillNewMember(page);
  await switchFor(page, 'floor-toggle-ground-floor').check();
  await switchFor(page, 'page-toggle-ground-floor-payments').check();
  await switchFor(page, 'floor-toggle-first-floor').check();
  await switchFor(page, 'page-toggle-first-floor-catalog').check();
  await switchFor(page, 'floor-toggle-ground-floor').uncheck();
  await expect(page.getByTestId('floor-pages-ground-floor')).toHaveCount(0);
  await expect(switchFor(page, 'page-toggle-first-floor-catalog')).toBeChecked();
  await switchFor(page, 'floor-toggle-ground-floor').check();
  await expect(switchFor(page, 'page-toggle-ground-floor-payments')).not.toBeChecked();
  await switchFor(page, 'page-toggle-first-floor-catalog').uncheck();
  await expect(page.getByText('No page access. This person can sign in but cannot open business pages until you enable them.', { exact: true })).toBeVisible();
  await page.getByTestId('add-staff-save').click();
  await expect(page.getByTestId('add-staff-sheet')).toHaveCount(0);
  expect(writes[0].body.custom_access).toBe(true);
  expect(writes[0].body.access_grants).toEqual([]);
  expect(writes[0].body.floor_ids).toEqual(['first-floor', 'ground-floor']);
});

test('critical team delegation: editing is a draft and a failed save preserves action choices', async ({ page }) => {
  const { writes, state } = await teamFixture(page);
  await page.getByTestId('team-row-test-worker').click();
  await expect(switchFor(page, 'page-toggle-ground-floor-payments')).toBeChecked();
  await switchFor(page, 'action-toggle-ground-floor-payments-export').check();
  await switchFor(page, 'page-toggle-first-floor-catalog').check();
  expect(writes).toHaveLength(0);
  state.failSave = true;
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByRole('alert')).toHaveText('Save temporarily unavailable');
  await expect(switchFor(page, 'action-toggle-ground-floor-payments-export')).toBeChecked();
  await expect(switchFor(page, 'page-toggle-first-floor-catalog')).toBeChecked();
  state.failSave = false;
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  expect(writes).toHaveLength(2);
  expect(writes[1].body.access_grants).toEqual([
    { resource: 'payments', floor_id: 'ground-floor', actions: ['view', 'export'] },
    { resource: 'catalog', floor_id: 'first-floor', actions: ['view'] },
  ]);
});

test('critical team delegation: editing uses current floors and pages when the team list is stale', async ({ page }) => {
  const { state, writes } = await teamFixture(page, () => catalog, 'manager');
  state.floorIds = ['third-floor'];
  state.grants = [{ resource: 'payments', floor_id: 'third-floor', actions: ['view'] }];
  await page.getByTestId('team-row-test-worker').click();
  await expect(switchFor(page, 'floor-toggle-third-floor')).toBeChecked();
  await expect(switchFor(page, 'floor-toggle-ground-floor')).not.toBeChecked();
  await expect(switchFor(page, 'floor-toggle-first-floor')).not.toBeChecked();
  await expect(switchFor(page, 'page-toggle-third-floor-payments')).toBeChecked();
  await expect(page.getByTestId('edit-staff-role-worker')).toHaveText('Delegated staff');
  await expect(page.getByTestId('edit-staff-role-manager')).toHaveCount(0);
  await switchFor(page, 'page-toggle-third-floor-catalog').check();
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  expect(writes[0].body.floor_ids).toEqual(['third-floor']);
  expect(writes[0].body).toMatchObject({ role: 'worker', custom_access: true, access_profile: null });
  expect(writes[0].body.access_grants).toEqual([...state.grants, { resource: 'catalog', floor_id: 'third-floor', actions: ['view'] }]);
});

test('critical team delegation: Settings has one access editor and historical links open Team', async ({ page }) => {
  await teamFixture(page);
  await page.goto('/settings');
  await expect(page.getByTestId('settings-nav-team')).toBeVisible();
  await expect(page.getByTestId('settings-nav-permissions')).toHaveCount(0);
  await expect(page.getByTestId('settings-nav-access-grants')).toHaveCount(0);
  for (const path of ['/settings-permissions', '/settings-access-grants']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/team$/);
    await expect(page.getByTestId('team-row-test-worker')).toBeVisible();
  }
});

test('critical team delegation: failed permission loading preserves contacts and retry restores the saved grants', async ({ page }) => {
  const { writes, state } = await teamFixture(page);
  state.failGrants = true;
  await page.getByTestId('team-row-test-worker').click();
  await expect(page.getByText('Current access unavailable', { exact: true })).toBeVisible();
  await expect(page.getByTestId('edit-staff-save')).toBeEnabled();
  state.failGrants = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(switchFor(page, 'page-toggle-ground-floor-payments')).toBeChecked();
  await expect(page.getByTestId('edit-staff-save')).toBeEnabled();
  expect(writes).toHaveLength(0);
});

test('critical team delegation: removing the final page saves explicit no access', async ({ page }) => {
  const { writes } = await teamFixture(page);
  await page.getByTestId('team-row-test-worker').click();
  await expect(switchFor(page, 'page-toggle-ground-floor-payments')).toBeChecked();
  await switchFor(page, 'page-toggle-ground-floor-payments').uncheck();
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  expect(writes[0].body).toMatchObject({ custom_access: true, access_grants: [], floor_ids: ['ground-floor', 'first-floor'] });
});

async function personalSession(page: Page, grants: unknown[], path = '/access', beforeNavigate?: () => Promise<void>, floorIds = ['first-floor', 'ground-floor']) {
  const person = { ...member, floor_ids: floorIds };
  await mockSession(page, path, true, {
    staff: person, grants,
    floorAccess: { all_floors: false, floors: floors.filter(floor => floorIds.includes(floor.id)), floor_ids: person.floor_ids },
  });
  if (beforeNavigate) await beforeNavigate();
  const identity = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/me');
  await page.goto(path);
  expect(await (await identity).json()).toMatchObject({ id: member.id, team_role: member.team_role, custom_access: true });
  if (floorIds.length > 1) await expect(page.getByTestId('floor-switcher').filter({ visible: true }).first()).toBeVisible();
}

test('critical team delegation: floor switching lands on an allowed page and blank floors show no page access', async ({ page }) => {
  await personalSession(page, [{ resource: 'payments', floor_id: 'ground-floor', actions: ['view'] }]);
  await expect(page.getByTestId('no-page-access')).toBeVisible();
  await page.getByTestId('floor-switcher').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Ground Floor', exact: true }).click();
  await expect(page).toHaveURL(/\/payments$/);
  await page.getByTestId('floor-switcher').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'The Sanitary Bathroom', exact: true }).click();
  await expect(page).toHaveURL(/\/access$/);
  await expect(page.getByTestId('no-page-access')).toBeVisible();
});


test('critical team delegation: malformed older catalog blocks editing and saving until a valid retry', async ({ page }) => {
  let catalogResponse: unknown = { ...catalog, resources: [{ key: 'payments', label: 'Payments', actions: ['view'] }] };
  const { writes } = await teamFixture(page, () => catalogResponse);
  await expect(page.getByText('Access options unavailable', { exact: true })).toBeVisible();
  await page.getByTestId('team-add-btn').click();
  await expect(page.getByTestId('floor-delegation-editor')).toHaveCount(0);
  await expect(page.getByTestId('add-staff-save')).toBeDisabled();
  catalogResponse = { ...catalog, resources: [{ ...catalog.resources[0], actions: ['create'] }] };
  await page.getByRole('button', { name: 'Try again', exact: true }).last().click();
  await expect(page.getByText('Access options unavailable', { exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('add-staff-save')).toBeDisabled();
  catalogResponse = { ...catalog, action_descriptions: { view: 'Read only.' } };
  await page.getByRole('button', { name: 'Try again', exact: true }).last().click();
  await expect(page.getByText('Access options unavailable', { exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('add-staff-save')).toBeDisabled();
  catalogResponse = catalog;
  await page.getByRole('button', { name: 'Try again', exact: true }).last().click();
  await expect(page.getByTestId('floor-delegation-editor')).toBeVisible();
  await expect(page.getByTestId('add-staff-save')).toBeEnabled();
  expect(writes).toHaveLength(0);
});

test('critical team delegation: custom Settings preserves account controls and hides management links', async ({ page }) => {
  let sessionReads = 0;
  await personalSession(page, [], '/settings', async () => {
    await page.route('**/api/auth/sessions', route => { sessionReads++; return route.fulfill({ json: [] }); });
  });
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('Ground Floor Sales', { exact: true })).toBeVisible();
  for (const id of ['mfa', 'privacy', 'terms']) await expect(page.getByTestId(`settings-nav-${id}`)).toBeVisible();
  await expect(page.getByTestId('logout-all-devices')).toBeVisible();
  await expect(page.getByTestId('settings-logout')).toBeVisible();
  for (const id of ['team', 'permissions', 'access-grants', 'company', 'pdf', 'catalog', 'walkins', 'notifications', 'system']) await expect(page.getByTestId(`settings-nav-${id}`)).toHaveCount(0);
  await expect(page.getByText('No active sessions found.', { exact: true })).toBeVisible();
  expect(sessionReads).toBe(1);
  await expect(page.getByTestId('settings-nav-password')).toHaveCount(0);
  await expect(page.getByTestId('settings-owner-managed-password')).toBeVisible();
});


test('critical team delegation: account password deep link survives hydration and root still lands on no access', async ({ page }) => {
  await personalSession(page, [], '/settings-password');
  await expect(page).toHaveURL(/\/settings-password$/);
  await expect(page.getByRole('heading', { name: 'Password managed by owner', exact: true })).toBeVisible();
  await expect(page.getByTestId('owner-managed-password')).toBeVisible();
  await expect(page.getByTestId('current-password-input')).toHaveCount(0);
  await expect(page.getByTestId('no-page-access')).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/\/settings-password$/);
  await expect(page.getByTestId('owner-managed-password')).toBeVisible();
  await expect(page.getByTestId('current-password-input')).toHaveCount(0);
  await page.goto('/');
  await expect(page).toHaveURL(/\/access$/);
  await expect(page.getByTestId('no-page-access')).toBeVisible();
});


test('critical team delegation: no assigned floors keeps personal security pages usable and blocks business pages', async ({ page }) => {
  let businessReads = 0;
  await personalSession(page, [], '/settings', async () => {
    await page.route('**/api/auth/sessions', route => route.fulfill({ json: [] }));
    await page.route('**/api/products**', route => { businessReads++; return route.fulfill({ json: [] }); });
    await page.route('**/api/settings/company', route => { businessReads++; return route.fulfill({ json: {} }); });
  }, []);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('Ground Floor Sales', { exact: true })).toBeVisible();
  await expect(page.getByTestId('settings-nav-password')).toHaveCount(0);
  await expect(page.getByTestId('settings-owner-managed-password')).toBeVisible();
  await expect(page.getByTestId('settings-nav-mfa')).toBeVisible();
  await expect(page.getByTestId('logout-all-devices')).toBeVisible();
  await expect(page.getByTestId('floor-access-empty')).toHaveCount(0);
  await page.goto('/settings-password');
  await expect(page.getByTestId('owner-managed-password')).toBeVisible();
  await expect(page.getByTestId('current-password-input')).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings-password$/);
  await page.reload();
  await expect(page.getByTestId('owner-managed-password')).toBeVisible();
  await expect(page.getByTestId('current-password-input')).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings-password$/);
  await page.goto('/settings-mfa');
  await expect(page.getByRole('heading', { name: 'Authenticator MFA', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings-mfa$/);
  for (const path of ['/catalog', '/settings-company']) {
    await page.goto(path);
    await expect(page.getByTestId('floor-access-empty')).toBeVisible();
    await expect(page.getByTestId('current-password-input')).toHaveCount(0);
  }
  expect(businessReads).toBe(0);
});

test('critical team delegation: a no-floor member with a legacy password flag can use their account', async ({ page }) => {
  await mockSession(page, '/settings', false, {
    staff: { ...member, floor_ids: [], must_change_password: true }, grants: [],
    floorAccess: { all_floors: false, floors: [], floor_ids: [] },
  });
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('force-change-current')).toHaveCount(0);
  await expect(page.getByTestId('settings-owner-managed-password')).toBeVisible();
  await expect(page.getByTestId('settings-nav-password')).toHaveCount(0);
});


test('critical team passwords: owner sets one member password and it remains owner managed', async ({ page }) => {
  const { writes } = await teamFixture(page);
  await page.getByTestId('team-row-test-worker').click();
  await expect(page.getByTestId('edit-staff-set-password')).toHaveAccessibleName('Save entered password');
  await expect(page.getByTestId('edit-staff-set-password-help')).toHaveText('Saves the password you entered and confirmed above.');
  await expect(page.getByTestId('edit-staff-reset-password')).toHaveAccessibleName('Generate and save random password');
  await expect(page.getByTestId('edit-staff-generate-password-help')).toContainText('It ignores the fields above.');
  await page.getByTestId('edit-staff-password').fill('SpecificMember!2026');
  await page.getByTestId('edit-staff-confirm-password').fill('SpecificMember!2026');
  await page.getByTestId('edit-staff-set-password').click();
  await expect(page.getByTestId('temp-password-dialog')).toBeVisible();
  await expect(page.getByTestId('temp-password-value')).toHaveText('SpecificMember!2026');
  await expect(page.getByText('This password applies only to this account and remains valid until the owner changes it. The member cannot change it.', { exact: true })).toBeVisible();
  expect(writes).toEqual([{ path: '/api/team/test-worker/reset-password', method: 'POST', body: { new_password: 'SpecificMember!2026' } }]);
  await page.getByTestId('temp-password-done').click();
  await expect(page.getByTestId('temp-password-value')).toHaveCount(0);
});

test('critical team passwords: generated member password and mismatched passwords', async ({ page }) => {
  const { writes } = await teamFixture(page);
  await page.getByTestId('team-row-test-worker').click();
  await page.getByTestId('edit-staff-password').fill('SpecificMember!2026');
  await page.getByTestId('edit-staff-confirm-password').fill('DifferentMember!2026');
  await page.getByTestId('edit-staff-set-password').click();
  await expect(page.getByRole('alert')).toHaveText("Passwords don't match");
  expect(writes).toHaveLength(0);
  await page.getByTestId('edit-staff-reset-password').click();
  await expect(page.getByTestId('temp-password-value')).toHaveText('GeneratedOwner!2026');
  expect(writes[0]).toMatchObject({ path: '/api/team/test-worker/reset-password', method: 'POST', body: {} });
});

test('critical team members: delete requires confirmation and removes only that member', async ({ page }) => {
  const { writes } = await teamFixture(page);
  await page.getByTestId('team-row-test-worker').click();
  await page.getByTestId('edit-staff-delete').click();
  await expect(page.getByTestId('confirm-delete-team-member')).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByTestId('confirm-delete-team-member-confirm').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  await expect(page.getByTestId('team-row-test-worker')).toHaveCount(0);
  expect(writes).toEqual([{ path: '/api/team/test-worker', method: 'DELETE', body: {} }]);
});

for (const role of ['admin', 'manager', 'sales', 'purchase', 'warehouse', 'accounts', 'worker']) {
  test(`critical ${role} cannot use member management or own password changes`, async ({ page }) => {
    let managementRequests = 0;
    await mockSession(page, '/team', false, { staff: { ...member, role, custom_access: false } });
    await page.route('**/api/team**', route => { managementRequests++; return route.fulfill({ status: 403, json: { detail: 'Owner only' } }); });
    await page.goto('/team');
    await expect(page.getByTestId('team-owner-only')).toBeVisible();
    await expect(page.getByTestId('team-add-btn')).toHaveCount(0);
    expect(managementRequests).toBe(0);
    await page.goto('/settings');
    await expect(page.getByTestId('settings-owner-managed-password')).toBeVisible();
    await expect(page.getByTestId('settings-nav-team')).toHaveCount(0);
    await expect(page.getByTestId('settings-nav-password')).toHaveCount(0);
    await page.goto('/settings-password');
    await expect(page.getByTestId('owner-managed-password')).toBeVisible();
    await expect(page.getByTestId('save-password-btn')).toHaveCount(0);
  });
}


test('critical owner keeps every floor and management function despite stale delegation fields', async ({ page }) => {
  await teamFixture(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 'audit-owner', email: 'owner@example.test', full_name: 'JK PATEL', role: 'owner', active: true, custom_access: true, access_profile: 'sanitary_purchases', floor_ids: [], must_change_password: true } }));
  let grantRequests = 0;
  await page.route('**/api/settings/access-grants/me', route => { grantRequests++; return route.fulfill({ status: 403, json: { detail: 'No delegated grants' } }); });
  await page.goto('/team');
  await expect(page.getByTestId('team-add-btn')).toBeVisible();
  await expect(page.getByTestId('floor-access-empty')).toHaveCount(0);
  expect(grantRequests).toBe(0);
  await page.goto('/settings');
  await expect(page.getByTestId('settings-nav-team')).toBeVisible();
  await expect(page.getByTestId('settings-nav-password')).toBeVisible();
  await page.goto('/settings-password');
  await expect(page.getByTestId('current-password-input')).toBeVisible();
});


test('critical team members: long names usernames emails and role labels stay inside every viewport', async ({ page }) => {
  await teamFixture(page);
  const longMember = { ...member, full_name: 'A'.repeat(120), email: `${'longmember'.repeat(12)}@example.test`, login_id: 'U'.repeat(120), team_role: 'Furniture Sales and Installation Coordination Department Supervisor and Assistant' };
  await page.route('**/api/team', route => route.fulfill({ json: [longMember] }));
  await page.reload();
  const row = page.getByTestId('team-row-test-worker');
  const badge = page.getByTestId('team-role-test-worker');
  await expect(row).toBeVisible();
  await expect(badge).toBeVisible();
  const rowBox = await row.boundingBox();
  const badgeBox = await badge.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(badgeBox!.x).toBeGreaterThanOrEqual(rowBox!.x);
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await row.click();
  await expect(page.getByTestId('edit-staff-username')).toHaveValue(longMember.login_id);
  await expect(page.getByTestId('edit-staff-password')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test('critical active owners keep their role enabled status and account', async ({ page }) => {
  const { writes } = await teamFixture(page, () => catalog, 'owner');
  await page.getByTestId('team-row-test-worker').click();
  await expect(page.getByTestId('edit-staff-owner-protected')).toBeVisible();
  await expect(page.getByTestId('edit-staff-active-switch').getByRole('switch')).toBeDisabled();
  await expect(page.getByTestId('edit-staff-delete')).toHaveCount(0);
  await page.getByTestId('edit-staff-role-worker').click();
  await expect(page.getByTestId('edit-staff-role-owner')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('edit-staff-set-password')).toBeVisible();
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  expect(writes).toHaveLength(0); // An unchanged save cannot rewrite owner access.
});

test('critical team contacts: malformed legacy responses cannot crash display or editing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { writes, state } = await teamFixture(page);
  state.members[0] = { ...state.members[0], login_id: 'JK', email: ['invalid'], phone: 9909906652, mobile: { number: 'invalid' } };
  await page.reload();
  await expect(page.getByTestId('team-row-test-worker')).toBeVisible();
  await expect(page.getByTestId('team-email-test-worker')).toHaveCount(0);
  await expect(page.getByTestId('team-phone-test-worker')).toHaveCount(0);
  await page.getByTestId('team-row-test-worker').click();
  for (const field of ['email', 'phone', 'mobile']) await expect(page.getByTestId(`edit-staff-${field}`)).toHaveValue('');
  if ((page.viewportSize()?.width || 0) >= 768) {
    const boxes = await Promise.all(['phone', 'mobile', 'email'].map(field => page.getByTestId(`edit-staff-${field}`).boundingBox()));
    for (const box of boxes) expect(box).not.toBeNull();
    expect(Math.max(...boxes.map(box => box!.y)) - Math.min(...boxes.map(box => box!.y))).toBeLessThan(2);
  }
  await page.getByTestId('edit-staff-phone').fill('+91 99099 06652');
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  expect(writes).toEqual([{ path: '/api/team/test-worker', method: 'PATCH', body: { phone: '+91 99099 06652' } }]);
  await page.reload();
  await expect(page.getByTestId('team-phone-test-worker')).toContainText('+91 99099 06652');
  expect(errors).toEqual([]);
});

test('critical team contacts: username-only creation, contact changes, clearing, reload and delete remain usable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { writes } = await teamFixture(page);
  await fillNewMember(page);
  await page.getByTestId('add-staff-email').fill('');
  await page.getByTestId('add-staff-phone').fill('+91 (079) 2345-6789');
  await page.getByTestId('add-staff-mobile').fill('+91 98765 43210');
  await page.getByTestId('add-staff-save').click();
  const row = page.getByTestId('team-row-created-worker');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('team-email-created-worker')).toHaveCount(0);
  expect(writes[0].body).toMatchObject({ email: null, phone: '+91 (079) 2345-6789', mobile: '+91 98765 43210', login_id: 'NEW WORKER' });
  await page.reload();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('edit-staff-phone')).toHaveValue('+91 (079) 2345-6789');
  await expect(page.getByTestId('edit-staff-mobile')).toHaveValue('+91 98765 43210');
  await page.getByTestId('edit-staff-email').fill(' new-worker@example.test ');
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('team-email-created-worker')).toHaveText('new-worker@example.test');
  expect(writes[1].body).toEqual({ email: 'new-worker@example.test' });
  await page.reload();
  await row.click();
  await page.getByTestId('edit-staff-phone').fill('');
  await page.getByTestId('edit-staff-mobile').fill('');
  await page.getByTestId('edit-staff-email').fill('');
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('team-phone-created-worker')).toHaveCount(0);
  await expect(page.getByTestId('team-email-created-worker')).toHaveCount(0);
  expect(writes[2].body).toEqual({ email: null, phone: null, mobile: null });
  await page.reload();
  await row.click();
  await page.getByTestId('edit-staff-delete').click();
  await page.getByTestId('confirm-delete-team-member-confirm').click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('team-add-btn')).toBeVisible();
  expect(errors).toEqual([]);
});

test('critical team contacts: invalid inputs block writes and preserve the draft', async ({ page }) => {
  const { writes } = await teamFixture(page);
  await fillNewMember(page);
  for (const [id, value, message] of [
    ['email', 'bad-address', 'Enter a valid email address'],
    ['phone', '123', 'Phone must contain 7–15 digits, with an optional country code'],
    ['mobile', '+91 abc 1234567', 'Mobile must contain 7–15 digits, with an optional country code'],
  ]) {
    await page.getByTestId(`add-staff-${id}`).fill(value);
    await page.getByTestId('add-staff-save').click();
    await expect(page.getByRole('alert')).toHaveText(message);
    await page.getByTestId(`add-staff-${id}`).fill(id === 'email' ? 'new-worker@example.test' : '');
  }
  await page.getByTestId('add-staff-email').fill('');
  await page.getByTestId('add-staff-username').fill('');
  await page.getByTestId('add-staff-save').click();
  await expect(page.getByRole('alert')).toHaveText('Add an email or username so this person can sign in');
  await expect(page.getByTestId('add-staff-name')).toHaveValue('New Worker');
  expect(writes).toHaveLength(0);
});

test('critical team contacts: contact-only edits preserve legacy role and credentials when access fails', async ({ page }) => {
  const { state, writes } = await teamFixture(page, () => catalog, 'manager');
  state.failGrants = true;
  await page.getByTestId('team-row-test-worker').click();
  await expect(page.getByText('Current access unavailable', { exact: true })).toBeVisible();
  await page.getByTestId('edit-staff-phone').fill('9876543210');
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  expect(writes[0].body).toEqual({ phone: '9876543210' });
  await page.reload();
  await expect(page.getByTestId('team-role-test-worker')).toHaveText('Ground Floor Sales');
  await expect(page.getByTestId('team-email-test-worker')).toHaveText(member.email);
});

test('critical team contacts: JK owner contact save never rewrites identity or access', async ({ page }) => {
  const { state, writes } = await teamFixture(page);
  state.members = [{ ...member, id: 'audit-owner', login_id: 'JK', full_name: 'JK PATEL', role: 'owner' }];
  await page.reload();
  await page.getByTestId('team-row-audit-owner').click();
  await page.getByTestId('edit-staff-mobile').fill('+91 98765 43210');
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  expect(writes[0]).toMatchObject({ path: '/api/team/audit-owner', body: { mobile: '+91 98765 43210' } });
  expect(Object.keys(writes[0].body)).toEqual(['mobile']);
  await page.reload();
  await expect(page.getByTestId('team-add-btn')).toBeVisible();
});

test('critical team contacts: structured validation failure remains readable and can be retried', async ({ page }) => {
  const { writes } = await teamFixture(page);
  let fail = true;
  await page.route('**/api/team/test-worker', route => {
    if (route.request().method() !== 'PATCH' || !fail) return route.fallback();
    return route.fulfill({ status: 422, json: { detail: [{ loc: ['body', 'phone'], msg: 'Enter a valid phone number', type: 'value_error' }] } });
  });
  await page.getByTestId('team-row-test-worker').click();
  await page.getByTestId('edit-staff-phone').fill('9876543210');
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByRole('alert')).toHaveText('phone: Enter a valid phone number');
  await expect(page.getByTestId('edit-staff-phone')).toHaveValue('9876543210');
  fail = false;
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  expect(writes).toHaveLength(1);
  await page.reload();
  await expect(page.getByTestId('team-row-test-worker')).toBeVisible();
});

test('critical team contacts: a failed refresh keeps the team usable and retry recovers saved details', async ({ page }) => {
  await teamFixture(page);
  let fail = true;
  await page.route('**/api/team', route => {
    if (route.request().method() === 'GET' && fail) return route.fulfill({ status: 503, json: { detail: 'Refresh temporarily unavailable' } });
    return route.fallback();
  });
  await page.getByTestId('team-row-test-worker').click();
  await page.getByTestId('edit-staff-phone').fill('9876543210');
  await page.getByTestId('edit-staff-save').click();
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  await expect(page.getByText('Could not load team', { exact: true })).toBeVisible();
  await expect(page.getByTestId('team-row-test-worker')).toBeVisible();
  await expect(page.getByTestId('team-add-btn')).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('team-phone-test-worker')).toContainText('9876543210');
  await expect(page.getByText('Could not load team', { exact: true })).toHaveCount(0);
});

test('critical team contacts: a delayed older refresh cannot resurrect a deleted member', async ({ page }) => {
  const { state } = await teamFixture(page);
  let delayed = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/team', async route => {
    if (route.request().method() !== 'GET' || delayed) return route.fallback();
    delayed = true;
    const oldTeam = structuredClone(state.members);
    await gate;
    await route.fulfill({ json: oldTeam });
  });
  await page.getByTestId('team-row-test-worker').click();
  await page.getByTestId('edit-staff-phone').fill('9876543210');
  await page.getByTestId('edit-staff-save').click();
  await expect.poll(() => delayed).toBe(true);
  await expect(page.getByTestId('edit-staff-sheet')).toHaveCount(0);
  await page.getByTestId('team-row-test-worker').click();
  await page.getByTestId('edit-staff-delete').click();
  await page.getByTestId('confirm-delete-team-member-confirm').click();
  await expect(page.getByTestId('team-row-test-worker')).toHaveCount(0);
  const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/team');
  release();
  await oldResponse;
  await expect(page.getByTestId('team-row-test-worker')).toHaveCount(0);
  await expect(page.getByText('No team members', { exact: true })).toBeVisible();
});
