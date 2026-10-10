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

async function teamFixture(page: Page, catalogResponse: () => unknown = () => catalog) {
  await mockSession(page, '/team');
  const writes: { path: string; body: Record<string, any> }[] = [];
  const state = { failSave: false, failGrants: false };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path.startsWith('/api/team')) {
      writes.push({ path, body: request.postDataJSON() });
      if (state.failSave) return route.fulfill({ status: 503, json: { detail: 'Save temporarily unavailable' } });
      return route.fulfill({ json: { ...member, ...request.postDataJSON() } });
    }
    if (path === '/api/team') return route.fulfill({ json: [member] });
    if (path === '/api/settings/floors') return route.fulfill({ json: floors });
    if (path === '/api/settings/access-grants/resources') return route.fulfill({ json: catalogResponse() });
    if (path === '/api/settings/access-grants/test-worker') return state.failGrants ? route.fulfill({ status: 503, json: { detail: 'Access temporarily unavailable' } }) : route.fulfill({ json: { grants: originalGrants } });
    if (path === '/api/roles') return route.fulfill({ json: [{ role: 'owner', label: 'Owner', level: 8 }, { role: 'worker', label: 'Worker', level: 1 }] });
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
  await page.getByTestId('add-staff-team-role').fill('Ground Floor Sales');
  await expect(page.getByTestId('floor-delegation-editor')).toBeVisible();
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
  expect(writes[0].body).toMatchObject({ custom_access: true, access_profile: null, floor_ids: ['ground-floor', 'first-floor'], team_role: 'Ground Floor Sales' });
  expect(writes[0].body.access_grants).toEqual([
    { resource: 'payments', floor_id: 'ground-floor', actions: ['view', 'create'] },
    { resource: 'tiles', floor_id: 'ground-floor', actions: ['view'] },
    { resource: 'catalog', floor_id: 'first-floor', actions: ['view'] },
  ]);
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

test('critical team delegation: failed permission loading blocks saving and retry restores the saved grants', async ({ page }) => {
  const { writes, state } = await teamFixture(page);
  state.failGrants = true;
  await page.getByTestId('team-row-test-worker').click();
  await expect(page.getByText('Current access unavailable', { exact: true })).toBeVisible();
  await expect(page.getByTestId('edit-staff-save')).toBeDisabled();
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

async function personalSession(page: Page, grants: unknown[]) {
  await mockSession(page, '/access');
  await page.route('**/api/auth/me', route => route.fulfill({ json: { ...member, floor_ids: ['first-floor', 'ground-floor'] } }));
  await page.route('**/api/settings/access-grants/me', route => route.fulfill({ json: { grants } }));
  await page.route('**/api/settings/floor-access', route => route.fulfill({ json: { all_floors: false, floors: floors.slice(0, 2), floor_ids: ['first-floor', 'ground-floor'] } }));
  await page.goto('/access');
  await expect(page.getByTestId('floor-switcher').filter({ visible: true }).first()).toBeVisible();
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
  catalogResponse = catalog;
  await page.getByRole('button', { name: 'Try again', exact: true }).last().click();
  await expect(page.getByTestId('floor-delegation-editor')).toBeVisible();
  await expect(page.getByTestId('add-staff-save')).toBeEnabled();
  expect(writes).toHaveLength(0);
});

test('critical team delegation: custom Settings preserves account controls and hides management links', async ({ page }) => {
  await personalSession(page, []);
  let sessionReads = 0;
  await page.route('**/api/auth/sessions', route => { sessionReads++; return route.fulfill({ json: [] }); });
  await page.goto('/settings');
  await expect(page.getByText('Ground Floor Sales', { exact: true })).toBeVisible();
  for (const id of ['password', 'mfa', 'privacy', 'terms']) await expect(page.getByTestId(`settings-nav-${id}`)).toBeVisible();
  await expect(page.getByTestId('logout-all-devices')).toBeVisible();
  await expect(page.getByTestId('settings-logout')).toBeVisible();
  for (const id of ['team', 'permissions', 'access-grants', 'company', 'pdf', 'catalog', 'walkins', 'notifications', 'system']) await expect(page.getByTestId(`settings-nav-${id}`)).toHaveCount(0);
  await expect(page.getByText('No active sessions found.', { exact: true })).toBeVisible();
  expect(sessionReads).toBe(1);
  await page.getByTestId('settings-nav-password').click();
  await expect(page).toHaveURL(/\/settings-password$/);
  await expect(page.getByRole('heading', { name: 'Change password', exact: true })).toBeVisible();
});
