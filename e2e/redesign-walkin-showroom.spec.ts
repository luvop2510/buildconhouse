import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const walkin = {
  id: 'walkin-showroom', number: 'WI-TEST', customer_id: 'prospect', customer_name: 'Showroom prospect',
  customer_phone: '9876543210', alternate_phone: null, floor_id: 'first-floor', salesperson_id: 'audit-owner',
  salesperson_name: 'Audit Owner', source: 'Reference', status: 'new', interested_products: [],
  visited_at: '2026-10-11T10:00:00Z', created_at: '2026-10-11T10:00:00Z', updated_at: '2026-10-11T10:00:00Z',
};
const followup = (id: string, name: string, origin?: string) => ({
  id, customer_id: 'prospect', customer_name: name, customer_tier: 'retail', customer_phone: '9876543210',
  floor_id: 'first-floor', rule_type: 'manual', category: 'walk_in', origin, walkin_id: origin ? walkin.id : null,
  reason: 'Visit Showroom', next_action: 'Arrange showroom visit', reason_factors: [], suggested_channel: 'visit',
  priority_score: 50, priority_level: 'medium', due_at: new Date().toISOString(), status: 'open',
  is_automated: false, auto_resolved: false, contact_attempts: 0, tags: [], bucket: 'today',
  assigned_to: 'audit-owner', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});

async function walkinReads(page: Page) {
  await page.route('**/api/walkins/config/sources', route => route.fulfill({ json: { sources: ['Walk-in', 'Reference', 'Instagram'] } }));
  await page.route('**/api/walkins/dashboard**', route => route.fulfill({ json: {
    today_walkins: 1, this_week: 1, pending_followups: 1, selections_scheduled: 0,
    converted: 0, lost: 0, conversion_rate: 0, avg_conversion_days: 0, total: 1,
  } }));
}

test('switching to Kitchen Floor opens its dedicated Kitchen hub', async ({ page }) => {
  await mockSession(page, '/dashboard');
  await page.goto('/dashboard');
  await page.getByTestId('floor-switcher').click();
  await page.getByRole('menuitem', { name: 'Kitchen Floor', exact: true }).click();
  await expect(page).toHaveURL(/\/kitchen$/);
  await expect(page.getByTestId('floor-switcher')).toHaveAccessibleName('Switch workspace. Current workspace: Kitchen Floor');
  await expect(page.getByRole('heading', { name: 'Kitchen dashboard', exact: true })).toBeVisible();
  await expect(page.getByTestId('kitchen-universal-search')).toBeVisible();
});

test('a saved Kitchen Floor workspace opens its dedicated Kitchen hub', async ({ page }) => {
  await mockSession(page, '/dashboard');
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('second-floor')));
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/kitchen$/);
  await expect(page.getByRole('heading', { name: 'Kitchen dashboard', exact: true })).toBeVisible();
  await expect(page.getByTestId('floor-switcher')).toHaveAccessibleName('Switch workspace. Current workspace: Kitchen Floor');
});

test('critical walk-ins combines multiple floors and lead sources in the same backend request', async ({ page }) => {
  await mockSession(page, '/walkins');
  await walkinReads(page);
  const filters: URLSearchParams[] = [];
  await page.route('**/api/walkins?**', route => {
    filters.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: [walkin] });
  });
  await page.goto('/walkins');
  await expect(page.getByTestId('floor-switcher')).toBeVisible();
  await expect(page.getByTestId('walkins-floor-first-floor')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => filters.at(-1)?.get('floor_ids')).toBe('first-floor');
  await page.getByTestId('walkins-floor-ground-floor').click();
  await page.getByTestId('walkins-source-filters-Reference').click();
  await page.getByTestId('walkins-source-filters-Instagram').click();
  await expect.poll(() => filters.at(-1)?.get('floor_ids')).toBe('first-floor,ground-floor');
  await expect.poll(() => filters.at(-1)?.get('source')).toBe('Reference,Instagram');
  await expect(page.getByTestId('walkins-source-filters-Reference')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('walkins-source-filters-Instagram')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('walkin-card-walkin-showroom')).toBeVisible();
});

test('critical Visit Showroom retries a failed transfer and opens only showroom-origin follow-ups', async ({ page }) => {
  await mockSession(page, '/walkins');
  await walkinReads(page);
  let transferred = false;
  await page.route('**/api/walkins?**', route => route.fulfill({ json: transferred ? [] : [{ ...walkin, floor_id: 'ground-floor' }] }));
  let attempts = 0;
  await page.route('**/api/walkins/walkin-showroom/visit-showroom', route => {
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    attempts += 1;
    if (attempts > 1) transferred = true;
    return attempts === 1 ? route.fulfill({ status: 503, json: { detail: 'Transfer unavailable; retry' } })
      : route.fulfill({ json: { walkin_id: walkin.id, followup_id: 'showroom:walkin-showroom' } });
  });
  await page.route('**/api/followups/config/assignees', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  const requestedOrigins: (string | null)[] = [];
  await page.route('**/api/followups/page?**', route => {
    requestedOrigins.push(new URL(route.request().url()).searchParams.get('origin'));
    // Include an unrelated row to exercise the UI's origin boundary as well.
    return route.fulfill({ json: { items: [followup('showroom:walkin-showroom', 'Transferred showroom visitor', 'visit_showroom'), followup('ordinary', 'Unrelated follow-up')], page: 1, page_size: 100, has_more: false } });
  });
  await page.goto('/walkins');
  await page.getByTestId('walkin-visit-showroom-walkin-showroom').click();
  await expect(page.getByText('Transfer unavailable; retry', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/walkins$/);
  await page.getByTestId('walkin-visit-showroom-walkin-showroom').click();
  await expect(page).toHaveURL(current => current.pathname === '/followups' && current.searchParams.get('workspace') === 'visit_showroom' && current.searchParams.get('showroom_followup') === 'showroom:walkin-showroom');
  await expect.poll(() => requestedOrigins.at(-1)).toBe('visit_showroom');
  await expect(page.getByText('Transferred showroom visitor', { exact: true })).toBeVisible();
  await expect(page.getByText('Unrelated follow-up', { exact: true })).toHaveCount(0);
  expect(attempts).toBe(2);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe('ground-floor');
  await page.goto('/walkins');
  await expect(page.getByTestId('walkin-card-walkin-showroom')).toHaveCount(0);
  await expect(page.getByTestId('walkin-visit-showroom-walkin-showroom')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('walkin-card-walkin-showroom')).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('critical sanitary walk-in cards never offer Ground Floor selection scheduling', async ({ page }) => {
  await mockSession(page, '/walkins');
  await walkinReads(page);
  await page.route('**/api/walkins?**', route => route.fulfill({ json: [walkin] }));
  await page.goto('/walkins');
  await expect(page.getByTestId('walkin-card-walkin-showroom')).toBeVisible();
  await expect(page.getByTestId('walkin-schedule-walkin-showroom')).toHaveCount(0);
  await expect(page.getByTestId('walkin-visit-showroom-walkin-showroom')).toBeVisible();
});

test('critical multi-floor walk-in actions use the selected records floor', async ({ page }) => {
  await mockSession(page, '/walkins');
  await walkinReads(page);
  const crossFloor = { ...walkin, floor_id: 'ground-floor' };
  await page.route('**/api/walkins?**', route => route.fulfill({ json: [crossFloor] }));
  let requestedFloor: string | undefined;
  await page.route('**/api/walkins/walkin-showroom', route => {
    requestedFloor = route.request().headers()['x-floor-id'];
    expect(route.request().postDataJSON()).toMatchObject({ status: 'selection_scheduled' });
    return route.fulfill({ json: { ...crossFloor, status: 'selection_scheduled' } });
  });
  await page.goto('/walkins');
  await page.getByTestId('walkins-floor-ground-floor').click();
  await page.getByTestId('walkin-schedule-walkin-showroom').click();
  await expect.poll(() => requestedFloor).toBe('ground-floor');
  await expect(page.getByText('Marked as Selection Scheduled', { exact: true })).toBeVisible();
});

test('critical Customers requests confirmed orders while prospective contacts stay out of the directory', async ({ page }) => {
  await mockSession(page, '/customers');
  const confirmedQueries: (string | null)[] = [];
  await page.route('**/api/customers?**', route => {
    const confirmed = new URL(route.request().url()).searchParams.get('confirmed_only');
    confirmedQueries.push(confirmed);
    return route.fulfill({ json: confirmed === 'true' ? [{ id: 'buyer', name: 'Confirmed buyer', tier: 'retail', phone: '9876543210' }]
      : [{ id: 'prospect', name: 'Unconfirmed prospect', tier: 'retail' }] });
  });
  await page.goto('/customers');
  await expect(page.getByText('Confirmed buyer', { exact: true })).toBeVisible();
  await expect(page.getByText('Unconfirmed prospect', { exact: true })).toHaveCount(0);
  expect(confirmedQueries.length).toBeGreaterThan(0);
  expect(confirmedQueries.every(value => value === 'true')).toBe(true);
});


test('critical Follow-ups workspace tabs publish durable showroom and quotation routes', async ({ page }) => {
  await mockSession(page, '/followups', false);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('ground-floor')));
  await page.route('**/api/followups/config/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/page?**', route => {
    const origin = new URL(route.request().url()).searchParams.get('origin');
    return route.fulfill({ json: { items: origin ? [followup('showroom:durable', 'Durable showroom visitor', 'visit_showroom')] : [], page: 1, page_size: 100, has_more: false } });
  });
  await page.goto('/followups');
  await page.getByTestId('followups-workspace-tabs-visit_showroom').click();
  await expect(page).toHaveURL(url => url.searchParams.get('workspace') === 'visit_showroom');
  await expect(page.getByText('Durable showroom visitor', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Durable showroom visitor', { exact: true })).toBeVisible();
  await page.getByTestId('followups-workspace-tabs-quotation_tiles').click();
  await expect(page).toHaveURL(url => url.searchParams.get('workspace') === 'quotation_tiles');
  const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/followups/page' && new URL(request.url()).searchParams.get('rule_type') === 'quotation_tiles_waiting');
  await page.reload(); await request;
  await expect(page.getByTestId('followups-workspace-tabs-quotation_tiles')).toHaveAttribute('aria-selected', 'true');
});

test('critical walk-in detail transfer opens showroom follow-ups on the actual record floor', async ({ page }) => {
  await mockSession(page, '/walkins/walkin-showroom', false);
  const crossFloor = { ...walkin, floor_id: 'ground-floor' };
  await page.route('**/api/walkins/walkin-showroom', route => route.fulfill({ json: crossFloor }));
  await page.route('**/api/walkins/walkin-showroom/timeline', route => route.fulfill({ json: [] }));
  await page.route('**/api/walkins/assignees', route => route.fulfill({ json: [] }));
  await page.route('**/api/walkins/walkin-showroom/visit-showroom', route => {
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    return route.fulfill({ json: { walkin_id: walkin.id, followup_id: 'showroom:detail-transfer' } });
  });
  await page.route('**/api/followups/config/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/page?**', route => {
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    expect(new URL(route.request().url()).searchParams.get('origin')).toBe('visit_showroom');
    return route.fulfill({ json: { items: [{ ...followup('showroom:detail-transfer', 'Detail showroom visitor', 'visit_showroom'), floor_id: 'ground-floor' }], page: 1, page_size: 100, has_more: false } });
  });
  await page.goto('/walkins/walkin-showroom');
  await page.getByTestId('walkin-visit-showroom').click();
  await expect(page).toHaveURL(url => url.pathname === '/followups' && url.searchParams.get('showroom_followup') === 'showroom:detail-transfer');
  await expect(page.getByText('Detail showroom visitor', { exact: true })).toBeVisible();
  await expect(page.getByTestId('floor-switcher')).toHaveAccessibleName('Switch workspace. Current workspace: Ground Floor');
});
