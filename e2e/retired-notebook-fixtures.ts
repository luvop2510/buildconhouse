import { expect, type Page } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';

/** Retired bookmarks must resolve through the current floor, never their slug. */
export async function retiredNotebookRedirect(page: Page, path: string, destination: 'walkins' | 'followups', floorId = 'first-floor', viewOnly = false) {
  await mockSession(page, path, false, viewOnly ? {
    staff: { id: 'viewer', full_name: 'Viewer', role: 'sales', active: true, custom_access: true, floor_ids: [floorId] },
    grants: [{ floor_id: floorId, resource: destination, actions: ['view'] }],
    floorAccess: { all_floors: false, floors: floors.filter(floor => floor.id === floorId), floor_ids: [floorId] },
  } : {});
  await page.addInitScript(id => localStorage.setItem('forge.active-floor', JSON.stringify(id)), floorId);
  let retiredReads = 0;
  await page.route('**/api/followups/notebook/**', route => {
    retiredReads += 1;
    return route.fulfill({ status: 410, json: { detail: 'Retired workspace' } });
  });
  await page.route('**/api/followups/config/assignees', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/config/customers', route => route.fulfill({ json: [] }));
  await page.route('**/api/walkins/dashboard', route => route.fulfill({ json: { today_walkins: 1, this_week: 1, total: 1 } }));
  const row = {
    id: 'retained-customer', customer_id: 'client', customer_name: 'Retained floor customer', floor_id: floorId,
    customer_tier: 'retail', customer_phone: '9000000000', rule_type: 'manual', category: 'general',
    reason: 'Discuss samples', reason_factors: [], next_action: 'Call customer', suggested_channel: 'call',
    priority_score: 50, priority_level: 'medium', due_at: new Date().toISOString(), status: 'open',
    is_automated: false, contact_attempts: 0, tags: [], bucket: 'today',
    number: 'WI-RETAINED', salesperson_id: 'audit-owner', salesperson_name: 'Audit Owner', source: 'Walk-in',
    interested_products: [], visited_at: new Date().toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await page.route(destination === 'followups' ? '**/api/followups/page?**' : /\/api\/walkins(?:\?|$)/, route => {
    expect(route.request().headers()['x-floor-id']).toBe(floorId);
    return route.fulfill({ json: destination === 'followups' ? { items: [row], page: 1, page_size: 100, has_more: false } : [{ ...row, status: 'new' }] });
  });
  if (floorId === 'second-floor') await page.route('**/api/kitchen-projects**', route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({ json: pathname.endsWith('/configuration') ? { version: 1, department_manager_user_ids: [], files: { max_bytes: 25000000, allowed_types: ['application/pdf'] } } : pathname.endsWith('/assignees') ? { rows: [] } : { rows: [], total: 0, limit: 25, page: 1 } });
  });
  await page.goto(path);
  if (floorId === 'second-floor') {
    await expect(page).toHaveURL(/\/kitchen\/stages\/lead$/);
    await expect(page.getByTestId('kitchen-search')).toBeVisible();
    await expect(page.getByTestId('walkin-new-btn')).toHaveCount(0);
    await expect(page.getByTestId('new-followup-btn')).toHaveCount(0);
    expect(retiredReads).toBe(0);
    return row;
  }
  await expect(page).toHaveURL(new RegExp(`/${destination}$`));
  await expect(page.getByText('Retained floor customer', { exact: true })).toBeVisible();
  expect(retiredReads).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  return row;
}
