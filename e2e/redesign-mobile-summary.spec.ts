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
  await page.route('**/api/walkins?**', route => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    const statuses = params.get('status')?.split(',');
    return route.fulfill({ json: rows.filter(row => !statuses || statuses.includes(row.status)) });
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
    const before = queries.length;
    await page.getByRole('button', { name: new RegExp(`^${label.replace('.', '\\.')}:`) }).click();
    await expect.poll(() => queries.length).toBeGreaterThan(before);
    expect(queries.at(-1)?.get('status')).toBe(status);
    if (label === 'Today' || label === 'This Week') expect(queries.at(-1)?.get('date_from')).toBeTruthy();
    await expect(page.locator('[data-testid^="walkin-card-summary-"]')).toHaveCount(count);
  }
  await page.getByTestId('walkins-source-filters-Reference').click();
  await expect.poll(() => queries.at(-1)?.get('source')).toBe('Reference');
  if ((page.viewportSize()?.width || 1440) < 700) {
    await page.getByTestId('walkins-filters-toggle').click();
    await expect(page.getByTestId('walkins-source-filters-Reference')).toBeHidden();
    await page.getByTestId('walkins-filters-toggle').click();
    await expect(page.getByTestId('walkins-source-filters-Reference')).toHaveAttribute('aria-checked', 'true');
    expect(queries.at(-1)?.get('source')).toBe('Reference');
  }
});

for (const metric of ['expiring'] as const) {
  test(`critical Follow-up ${metric} summary clears unrelated filters and opens its exact records`, async ({ page }) => {
    const runtime = captureRuntimeHealth(page);
    await mockSession(page, '/followups');
    const queries: URLSearchParams[] = [];
    const now = new Date().toISOString();
    let releaseSearch!: () => void;
    const heldSearch = new Promise<void>(resolve => { releaseSearch = resolve; });
    const base = { customer_id: 'summary-customer', customer_tier: 'retail', customer_phone: '9876543210', floor_id: 'first-floor', category: 'quotation', reason: 'Summary record', next_action: 'Contact customer', reason_factors: [], suggested_channel: 'call', priority_score: 50, priority_level: 'medium', due_at: now, contact_attempts: 0, tags: [], created_at: now, updated_at: now };
    await page.route('**/api/followups/stats', route => route.fulfill({ json: { today_tasks: 0, overdue: 0, expiring_quotations_count: 1, waiting_for_customer: 0, completed_today: 2, completed_trend: 0, rules: [], workspace_counts: {} } }));
    await page.route('**/api/followups/mission', route => route.fulfill({ json: null }));
    await page.route('**/api/followups/page?**', async route => {
      const params = new URL(route.request().url()).searchParams;
      queries.push(params);
      if (params.get('q') === 'Unrelated search') await heldSearch;
      const items = params.get('bucket') === 'completed_today'
        ? ['won', 'lost'].map(outcome => ({ ...base, id: outcome, customer_name: `Completed ${outcome}`, rule_type: 'manual', status: 'done', bucket: 'completed', completed_outcome: outcome, completed_at: now, auto_resolved: outcome === 'won' }))
        : [
          { ...base, id: 'expiring', customer_name: 'Expiring customer', rule_type: 'quotation_expiring', status: 'open', bucket: 'today' },
          { ...base, id: 'ordinary', customer_name: 'Ordinary quotation', rule_type: 'quotation_waiting', status: 'open', bucket: 'today' },
        ];
      return route.fulfill({ json: { items, page: 1, page_size: 100, has_more: false } });
    });
    await page.goto('/followups');
    await expect(page.getByText('Expiring customer', { exact: true })).toBeVisible();
    await page.getByTestId('followups-search').fill('Unrelated search');
    await expect.poll(() => queries.at(-1)?.get('q')).toBe('Unrelated search');
    await page.getByRole('button', { name: 'Summary', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Completed Today:/ })).toHaveCount(0);
    const summaryAction = page.getByRole('button', { name: /^Expiring Soon:/ });
    await summaryAction.scrollIntoViewIfNeeded();
    const beforeSettle = await summaryAction.boundingBox();
    expect(beforeSettle).not.toBeNull();
    const searchResponse = page.waitForResponse(response => response.url().includes('/api/followups/page?') && new URL(response.url()).searchParams.get('q') === 'Unrelated search');
    await page.mouse.move(beforeSettle!.x + beforeSettle!.width / 2, beforeSettle!.y + beforeSettle!.height / 2);
    await page.mouse.down();
    try {
      releaseSearch();
      await searchResponse;
      // The queue's loading state settles during the gesture. Optional content
      // must not move the tile out from under the worker's finger or pointer.
      await expect(page.getByText('Summary unavailable. Your task queue is still available below.', { exact: true })).toBeVisible();
      const afterSettle = await summaryAction.boundingBox();
      expect(afterSettle?.y).toBeCloseTo(beforeSettle!.y, 0);
    } finally {
      releaseSearch();
      await page.mouse.up();
    }
    await expect(page.getByTestId('followups-search')).toHaveValue('');
    if (metric === 'expiring') {
      await expect.poll(() => queries.at(-1)?.get('rule_type')).toBe('quotation_expiring');
      await expect(page.getByText('Expiring customer', { exact: true })).toBeVisible();
      await expect(page.getByText('Ordinary quotation', { exact: true })).toHaveCount(0);
    } else {
      await expect.poll(() => queries.at(-1)?.get('bucket')).toBe('completed_today');
      await expect(page.getByText('Completed won', { exact: true })).toBeVisible();
      await expect(page.getByText('Completed lost', { exact: true })).toBeVisible();
    }
    expect(queries.at(-1)?.has('q')).toBe(false);
    expect(queries.at(-1)?.has('category')).toBe(false);

    if ((page.viewportSize()?.width || 1440) < 700) {
      // A real press can outlast the blur settlement delay. Restoring phone
      // chrome before release moves the target and cancels RN's onPress.
      const search = page.getByTestId('followups-search');
      const chrome = page.getByTestId('mobile-workspace-header');
      await search.fill('Held press search');
      await expect.poll(() => queries.at(-1)?.get('q')).toBe('Held press search');
      await page.getByRole('button', { name: 'Summary', exact: true }).click();
      await search.focus();
      await expect(chrome).toBeHidden();
      const expiring = page.getByRole('button', { name: /^Expiring Soon:/ });
      await expiring.scrollIntoViewIfNeeded();
      const beforePress = await expiring.boundingBox();
      expect(beforePress).not.toBeNull();
      await page.mouse.move(beforePress!.x + beforePress!.width / 2, beforePress!.y + beforePress!.height / 2);
      await page.mouse.down();
      try {
        // Intentional gesture duration, beyond the existing 150ms blur delay.
        await page.waitForTimeout(250);
        await expect(chrome).toBeHidden();
        const duringPress = await expiring.boundingBox();
        expect(duringPress?.y).toBeCloseTo(beforePress!.y, 0);
      } finally {
        await page.mouse.up();
      }
      await expect(search).toHaveValue('');
      await expect.poll(() => queries.at(-1)?.get('rule_type')).toBe('quotation_expiring');
      expect(queries.at(-1)?.has('q')).toBe(false);
      await expect(page.getByText('Expiring customer', { exact: true })).toBeVisible();
      await expect(chrome).toBeVisible();
    }
    await runtime.assertHealthy();
  });
}
