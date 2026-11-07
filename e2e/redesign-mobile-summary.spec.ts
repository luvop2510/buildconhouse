import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const baseWalkin = {
  number: 'WI-SUMMARY', customer_id: 'summary-customer', customer_phone: '9876543210', alternate_phone: null,
  floor_id: 'first-floor', salesperson_id: 'audit-owner', salesperson_name: 'Audit Owner', source: 'Reference', interested_products: [],
  visited_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

test('critical Walk-in summary opens every matching metric and hidden filters retain selections', async ({ page }) => {
  await mockSession(page, '/walkins');
  const queries: URLSearchParams[] = [];
  const rows = ['new', 'contacted', 'selection_scheduled', 'selection_completed', 'quotation_created', 'converted', 'lost'].map(status => ({
    ...baseWalkin, id: `summary-${status}`, status, customer_name: `Summary ${status}`,
  }));
  await page.route('**/api/walkins/config/sources', route => route.fulfill({ json: { sources: ['Reference', 'Instagram'] } }));
  await page.route('**/api/walkins/dashboard**', route => route.fulfill({ json: {
    today_walkins: 7, this_week: 7, pending_followups: 3, selections_scheduled: 1, converted: 3, lost: 1, conversion_rate: 75, avg_conversion_days: 2, total: 7,
  } }));
  await page.route('**/api/walkins/page?**', route => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    const statuses = params.get('status')?.split(',');
    return route.fulfill({ json: { items: rows.filter(row => !statuses || statuses.includes(row.status)), next_cursor: null } });
  });
  await page.goto('/walkins');
  await expect(page.getByTestId('walkin-card-summary-new')).toBeVisible();
  await page.getByRole('button', { name: 'Walk-in summary', exact: true }).click();
  const cases = [
    ['Pending Follow-ups', 'new,contacted,selection_scheduled', 3],
    ['Selections Scheduled', 'selection_scheduled', 1],
    ['Converted', 'selection_completed,quotation_created,converted', 3],
    ['Lost', 'lost', 1],
    ['Conversion Rate', 'selection_completed,quotation_created,converted,lost', 4],
    ['Avg. Conversion', 'selection_completed,quotation_created,converted', 3],
    ['Today', null, 7],
    ['This Week', null, 7],
  ] as const;
  for (const [label, status, count] of cases) {
    await page.getByRole('button', { name: new RegExp(`^${label.replace('.', '\\.')}:`) }).click();
    await expect(page.locator('[data-testid^="walkin-card-summary-"]')).toHaveCount(count);
    // Repeated metrics may reuse the same fresh, floor-scoped response.
    expect(queries.some(query => query.get('status') === status &&
      (!(label === 'Today' || label === 'This Week') || Boolean(query.get('date_from'))))).toBe(true);
  }
  await page.getByTestId('walkins-source-filters-Reference').click();
  await expect.poll(() => queries.at(-1)?.get('source')).toBe('Reference');
  await page.getByTestId('walkins-search').fill('Summary');
  await page.getByTestId('walkins-search').blur();
  await expect.poll(() => queries.at(-1)?.get('search')).toBe('Summary');
  const beforeHide = queries.length;
  await page.getByTestId('walkins-filters-toggle').click();
  await expect(page.getByTestId('walkins-filters-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('walkins-source-filters-Reference')).toBeHidden();
  await expect(page.getByTestId('walkins-search')).toBeHidden();
  await page.getByTestId('walkins-filters-toggle').click();
  await expect(page.getByTestId('walkins-source-filters-Reference')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('walkins-search')).toHaveValue('Summary');
  expect(queries.at(-1)?.get('source')).toBe('Reference');
  expect(queries.length).toBe(beforeHide);
});

test('critical Walk-in register renders without waiting for the optional summary', async ({ page }) => {
  await mockSession(page, '/walkins');
  let releaseSummary!: () => void;
  const held = new Promise<void>(resolve => { releaseSummary = resolve; });
  await page.route('**/api/walkins/dashboard**', async route => {
    await held;
    await route.fulfill({ status: 503, json: { detail: 'Summary temporarily unavailable' } });
  });
  await page.route('**/api/walkins/page?**', route => route.fulfill({ json: { items: [
    { ...baseWalkin, id: 'primary-register', status: 'new', customer_name: 'Available walk-in' },
  ], next_cursor: null } }));
  await page.goto('/walkins');
  try {
    await expect(page.getByTestId('walkin-card-primary-register')).toBeVisible();
    await expect(page.getByText('Loading walk-ins…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Walk-in summary', exact: true }).click();
    releaseSummary();
    await expect(page.getByText('Summary unavailable. Your walk-in register is still available below.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('walkin-card-primary-register')).toBeVisible();
  } finally { releaseSummary(); }
});

test('critical Walk-in pages keep rows on failure, retry their boundary and reset after search', async ({ page }) => {
  await mockSession(page, '/walkins');
  const rows = Array.from({ length: 90 }, (_, index) => ({ ...baseWalkin, id: `paged-${index}`, status: 'new', customer_name: `Paged visitor ${index}` }));
  const requests: URLSearchParams[] = [];
  let failMore = true, legacyReads = 0;
  await page.route(/\/api\/walkins(?:\?|$)/, route => { legacyReads++; return route.fulfill({ json: rows }); });
  await page.route('**/api/walkins/page?**', route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    expect(params.get('limit')).toBe('40');
    expect(params.get('floor_ids')).toBe('first-floor');
    if (params.get('search')) return route.fulfill({ json: { items: [rows[89]], next_cursor: null } });
    const boundary = params.get('before_id');
    if (boundary && failMore) return route.fulfill({ status: 503, json: { detail: 'Next page temporarily unavailable' } });
    const start = boundary ? Number(boundary.slice('paged-'.length)) + 1 : 0;
    const items = rows.slice(start, start + 40);
    const last = items.at(-1)!;
    return route.fulfill({ json: { items, next_cursor: start + 40 < rows.length ? { visited_at: last.visited_at, id: last.id } : null } });
  });
  await page.goto('/walkins');
  await expect(page.locator('[data-testid^="walkin-card-paged-"]')).toHaveCount(40);
  await page.getByTestId('walkins-show-more').click();
  await expect(page.getByText('Could not load more walk-ins', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid^="walkin-card-paged-"]')).toHaveCount(40);
  expect(requests.at(-1)?.get('before_id')).toBe('paged-39');
  failMore = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).filter({ visible: true }).last().click();
  await expect(page.locator('[data-testid^="walkin-card-paged-"]')).toHaveCount(80);
  expect(requests.at(-1)?.get('before_id')).toBe('paged-39');
  await page.getByTestId('walkins-show-more').click();
  await expect(page.locator('[data-testid^="walkin-card-paged-"]')).toHaveCount(90);
  await expect(page.getByTestId('walkins-show-more')).toHaveCount(0);
  await page.getByTestId('walkins-search').fill('Paged visitor 89');
  await expect(page.locator('[data-testid^="walkin-card-paged-"]')).toHaveCount(1);
  expect(requests.at(-1)?.get('before_id')).toBe(null);
  expect(legacyReads).toBe(0);
});

test('critical Furniture follow-ups keep search and salesperson filters without summary controls', async ({ page }) => {
  const runtime = captureRuntimeHealth(page);
  await mockSession(page, '/followups', false, { floorId: 'third-floor' });
  const queries: URLSearchParams[] = [];
  const summaryReads: string[] = [];
  const now = new Date().toISOString();
  await page.route('**/api/followups/config/assignees', route => route.fulfill({ json: [
    { id: 'furniture-worker', full_name: 'Furniture salesperson', role: 'sales' },
  ] }));
  await page.route(/\/api\/followups\/(stats|mission)(\?.*)?$/, route => {
    summaryReads.push(route.request().url());
    return route.fulfill({ status: 500, json: { detail: 'Removed summaries must not load' } });
  });
  await page.route('**/api/followups/page?**', route => {
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    const items = [{ id: 'furniture-followup', customer_id: 'summary-customer', customer_name: 'Furniture customer',
      customer_tier: 'retail', customer_phone: '9876543210', floor_id: 'third-floor', category: 'quotation',
      rule_type: 'quotation_expiring', reason: 'Contact about quotation', next_action: 'Call customer', reason_factors: [],
      suggested_channel: 'call', priority_score: 50, priority_level: 'medium', due_at: now, status: 'open', bucket: 'today',
      contact_attempts: 0, tags: [], created_at: now, updated_at: now, assigned_to: 'furniture-worker', assigned_to_name: 'Furniture salesperson' }];
    return route.fulfill({ json: { items, page: 1, page_size: 100, has_more: false } });
  });
  await page.goto('/followups');
  const card = page.getByTestId('followup-furniture-followup');
  await expect(card).toContainText('Furniture customer');
  await expect(card).toContainText('Salesperson: Furniture salesperson');
  await expect(page.getByTestId('followups-salesperson-mine')).toHaveCount(0);
  await expect(page.getByTestId('followups-owner')).toHaveCount(0);
  await expect(page.getByText(/^(PRIORITY|TYPE|OWNER|Summary|Today's Tasks|Expiring Soon)$/)).toHaveCount(0);
  await page.getByTestId('followups-salesperson-furniture-worker').click();
  await expect.poll(() => queries.at(-1)?.get('assigned_to')).toBe('furniture-worker');
  await page.getByTestId('followups-search').fill('Furniture');
  await expect.poll(() => queries.at(-1)?.get('q')).toBe('Furniture');
  const readsBeforeHide = queries.length;
  await page.getByTestId('followups-filters-toggle').click();
  await expect(page.getByTestId('followups-search')).toBeHidden();
  await page.getByTestId('followups-filters-toggle').click();
  await expect(page.getByTestId('followups-search')).toHaveValue('Furniture');
  await expect(page.getByTestId('followups-salesperson-furniture-worker')).toHaveAttribute('aria-checked', 'true');
  expect(queries.length).toBe(readsBeforeHide);
  expect(summaryReads).toEqual([]);
  await runtime.assertHealthy();
});
