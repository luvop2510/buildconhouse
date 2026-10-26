import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const draftReminder = {
  id: 'sanitary-draft', customer_id: 'draft-customer', customer_name: 'Draft quotation customer',
  customer_phone: '9000000000', customer_tier: 'retail', floor_id: 'first-floor',
  quotation_id: 'draft-quotation', quotation_number: 'Q-DRAFT-7',
  rule_type: 'quotation_followup', category: 'quotation', value: 0,
  reason: 'Quotation draft created 7 day(s) ago; no order placed — time to follow up.',
  reason_factors: ['7-day follow-up window has passed'], next_action: 'Call customer',
  next_action_reason: '7-day follow-up window has passed.', suggested_channel: 'call',
  priority_score: 85, priority_level: 'critical', status: 'open', bucket: 'today',
  due_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  is_automated: true, auto_resolved: false, contact_attempts: 0, tags: ['Quotation draft'],
  assigned_to: 'sanitary-worker', assigned_to_name: 'Assigned salesperson',
};

test('critical sanitary follow-ups keeps draft source and salesperson without summary or priority clutter', async ({ page }, info) => {
  await mockSession(page, '/followups', false);
  const errors: string[] = [], summaryReads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/followups/config/assignees', route => route.fulfill({ json: [
    { id: 'sanitary-worker', full_name: 'Assigned salesperson', role: 'sales' },
  ] }));
  await page.route('**/api/followups/config/customers**', route => route.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', route => route.fulfill({ json: [] }));
  const filters: URLSearchParams[] = [];
  await page.route('**/api/followups/page?**', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    filters.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { items: [draftReminder], page: 1, page_size: 100, has_more: false } });
  });
  await page.route(/\/api\/followups\/(stats|mission)(\?.*)?$/, route => {
    summaryReads.push(route.request().url());
    return route.fulfill({ status: 500, json: { detail: 'Removed summaries must not load' } });
  });
  await page.goto('/followups');
  const card = page.getByTestId('followup-sanitary-draft');
  await expect(card).toContainText('Quotation draft created 7 day(s) ago; no order placed');
  await expect(card).toContainText('Salesperson: Assigned salesperson');
  await expect(card).toContainText('Today');
  await expect(page.getByTestId('followups-salesperson-all')).toBeVisible();
  await expect(page.getByTestId('followups-filters')).toHaveCount(0);
  await expect(page.getByTestId('followups-owner')).toHaveCount(0);
  await expect(page.getByText(/^(PRIORITY|TYPE|OWNER|Critical|High|Medium|Low)$/)).toHaveCount(0);
  await expect(page.getByText(/^(Today’s Mission|Today's Mission|Today's Tasks|Overdue Tasks|Expiring Soon|Waiting For Customer|Summary)$/)).toHaveCount(0);
  await expect(page.getByTestId('mission-jump-top')).toHaveCount(0);
  await expect(card.getByText('85', { exact: true })).toHaveCount(0);
  await page.getByTestId('followups-salesperson-sanitary-worker').click();
  await expect.poll(() => filters.at(-1)?.get('assigned_to')).toBe('sanitary-worker');
  expect(summaryReads).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('sanitary-followups.png'), fullPage: true });
});
