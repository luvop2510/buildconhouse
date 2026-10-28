import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

// Kitchen has a dedicated stage workspace; it is not a regular Walk-ins floor.
// Keep the Kitchen permission boundary explicit below instead of pretending
// its stage workspace is a regular Walk-ins floor.
for (const floor of floors.filter(floor => floor.id !== 'second-floor')) {
  test(`critical delegated Walk-ins uses the regular register and intake on ${floor.id}`, async ({ page }) => {
    const grants = [{ resource: 'walkins', floor_id: floor.id, actions: ['view', 'create', 'update'] }];
    const staff = { id: 'walkin-worker', email: 'worker@example.test', full_name: 'Walk-in Worker', role: 'worker',
      active: true, custom_access: true, floor_ids: [floor.id] };
    await mockSession(page, '/walkins', false, { staff, grants,
      floorAccess: { all_floors: false, floors: [floor], floor_ids: [floor.id] } });
    const walkin = { id: 'delegated-visitor', number: 'WI-DELEGATED', customer_id: 'visitor', customer_name: 'Delegated visitor',
      customer_phone: '9876543210', alternate_phone: null, floor_id: floor.id, salesperson_id: staff.id,
      salesperson_name: staff.full_name, source: 'Walk-in', status: 'new', interested_products: ['Bathroom fittings', 'Tiles'],
      visited_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const reads: string[] = [];
    await page.route('**/api/walkins**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      reads.push(path);
      if (path.endsWith('/config/sources')) return route.fulfill({ json: { sources: ['Walk-in'] } });
      if (path.endsWith('/config/assignees')) {
        expect(request.headers()['x-floor-id']).toBe(floor.id);
        return route.fulfill({ json: [{ id: staff.id, full_name: staff.full_name, role: 'worker' }] });
      }
      if (path.endsWith('/dashboard')) return route.fulfill({ json: { today_walkins: 1, this_week: 1, pending_followups: 1,
        selections_scheduled: 0, converted: 0, lost: 0, conversion_rate: 0, avg_conversion_days: 0, total: 1 } });
      if (path.endsWith('/check-duplicate')) {
        expect(request.headers()['x-floor-id']).toBe(floor.id);
        return route.fulfill({ json: { high: [], medium: [], low: [] } });
      }
      if (path.endsWith('/timeline')) return route.fulfill({ json: [] });
      if (path.endsWith('/visit-showroom')) return route.fulfill({ json: { walkin_id: walkin.id, followup_id: 'showroom:delegated-visitor' } });
      if (path === '/api/walkins' && request.method() === 'POST') {
        expect(request.headers()['x-floor-id']).toBe(floor.id);
        expect(request.postDataJSON()).toMatchObject({ floor_id: floor.id, salesperson_id: staff.id });
        return route.fulfill({ json: walkin });
      }
      if (path === '/api/walkins') return route.fulfill({ json: [walkin] });
      return route.fulfill({ json: walkin });
    });
    await page.route('**/api/followups/assignees?**', r => r.fulfill({ json: [{ ...staff, floor_ids: [floor.id] }] }));
    await page.goto('/walkins');
    await expect(page.getByRole('heading', { name: 'Walk-ins', exact: true })).toBeVisible();
    await expect(page.getByTestId('walkin-card-delegated-visitor')).toContainText('Bathroom fittings, Tiles');
    await page.getByTestId('walkin-visit-showroom-delegated-visitor').click();
    await expect(page.getByTestId('walkin-card-delegated-visitor')).toHaveCount(0);
    await expect(page).toHaveURL(/\/walkins$/);
    await page.getByTestId('walkin-new-btn').click();
    if (['first-floor', 'ground-floor', 'third-floor'].includes(floor.id)) await expect(page.getByTestId('walkin-salesperson-row')).toHaveCount(0);
    else await expect(page.getByTestId('walkin-salesperson-row')).toContainText(staff.full_name);
    await page.getByTestId('walkin-name').fill('Delegated visitor');
    await page.getByTestId('walkin-phone').fill('9876543210');
    if (['first-floor', 'ground-floor', 'third-floor'].includes(floor.id)) await page.getByTestId(`lead-assign-${floor.id}-${staff.id}`).click();
    await page.getByTestId('walkin-save-btn').click();
    await expect(page).toHaveURL(new RegExp(`/walkins/delegated-visitor\\?floor_id=${floor.id}`));
    await expect(page.getByRole('heading', { name: 'Delegated visitor', exact: true })).toBeVisible();
    expect(reads).toContain('/api/walkins/config/assignees');
    expect(errors).toEqual([]);
    await expect(page.getByText(/^(VIP|TRADE|RETAIL)$/)).toHaveCount(0);
  });
}

test('critical Kitchen walk-ins grants cannot open the shared register or intake', async ({ page }) => {
  const staff = { id: 'kitchen-walkin-worker', email: 'kitchen-worker@example.test', full_name: 'Kitchen Worker', role: 'worker',
    active: true, custom_access: true, floor_ids: ['second-floor'] };
  await mockSession(page, '/walkins', false, { staff,
    grants: [{ resource: 'walkins', floor_id: 'second-floor', actions: ['view', 'create', 'update'] }],
    floorAccess: { all_floors: false, floors: floors.filter(floor => floor.id === 'second-floor'), floor_ids: ['second-floor'] },
  });
  let reads = 0;
  await page.route('**/api/walkins**', route => { reads++; return route.fulfill({ json: [] }); });
  await page.goto('/walkins');
  await expect(page).toHaveURL(/\/access$/);
  await expect(page.getByTestId('no-page-access')).toContainText('No pages enabled on this floor');
  expect(reads).toBe(0);
  await expect(page.getByTestId('walkin-new-btn')).toHaveCount(0);
  await page.goto('/walkins/new');
  await expect(page).toHaveURL(/\/access$/);
  expect(reads).toBe(0);
});
