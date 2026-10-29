import { expect, test } from '@playwright/test';
import { retiredNotebookRedirect } from './retired-notebook-fixtures';
import { mockSession } from './audit-fixtures';
import { todayFixture, mockTodayOverview } from './today-fixtures';

const row = {
  id: 'note-required', customer_id: 'client-1', customer_name: 'Note Required Customer',
  customer_tier: 'retail', customer_phone: '9000000000', rule_type: 'manual', category: 'general',
  value: 12000, reason: 'Confirm delivery', reason_factors: [], next_action: 'Call customer',
  suggested_channel: 'call', priority_score: 70, priority_level: 'high', due_at: new Date().toISOString(),
  status: 'open', is_automated: false, auto_resolved: false, contact_attempts: 0, tags: [], bucket: 'today',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), assigned_to: 'eligible-worker', floor_id: 'first-floor',
};

test('critical Follow-ups Done is note-free and retains the task after a failed save', async ({ page }) => {
  await mockSession(page, '/followups');
  await page.route('**/api/followups/assignees?**', r => r.fulfill({ json: [{ id: 'eligible-worker', full_name: 'Eligible worker', role: 'sales', floor_ids: ['first-floor'] }] }));
  await page.route('**/api/followups/config/assignees', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/page?**', r => r.fulfill({ json: { items: [row], page: 1, page_size: 100, has_more: false } }));
  const writes: any[] = [];
  let fail = true;
  await page.route('**/api/followups/note-required/complete', r => {
    writes.push(r.request().postDataJSON());
    return fail ? r.fulfill({ status: 503, json: { detail: 'Could not save the follow-up' } })
      : r.fulfill({ json: { ...row, status: 'done', bucket: 'completed' } });
  });
  await page.goto('/followups');
  await page.getByTestId('complete-note-required').click();
  await expect(page.getByText('Could not save the follow-up', { exact: true })).toBeVisible();
  await expect(page.getByTestId('complete-note-required')).toBeVisible();
  await expect(page.getByTestId('followup-change-note')).toHaveCount(0);
  fail = false;
  await page.getByTestId('complete-note-required').click();
  await expect(page.getByTestId('complete-note-required')).toHaveCount(0);
  expect(writes).toEqual([{}, {}]);
});

test('critical dashboard Done completes directly without a note', async ({ page }) => {
  await mockSession(page, '/dashboard', false, { staff: { id: 'audit-manager', email: 'manager@example.test', full_name: 'Audit Manager', role: 'manager', active: true, floor_ids: ['first-floor'] } });
  const data = todayFixture();
  data.tasks = [{id:row.id,resource:'followups',title:row.customer_name,status:'open',due_at:row.due_at,updated_at:row.updated_at,assignee_name:'Eligible worker',href:'/followups',progress:null}];
  await mockTodayOverview(page,data);
  await page.route('**/api/dashboard/today', r => r.fulfill({ json: data }));
  const writes: any[] = [];
  await page.route('**/api/followups/note-required/complete', r => {
    writes.push(r.request().postDataJSON());
    return r.fulfill({ json: { ...row, status: 'done' } });
  });
  await page.goto('/dashboard');
  await page.getByRole('button', {name:'Mark Note Required Customer done',exact:true}).click();
  await expect(page.getByTestId('today-task-followups-note-required')).toHaveCount(0);
  await expect(page.getByTestId('followup-change-note')).toHaveCount(0);
  expect(writes).toEqual([{}]);
});

test('critical retired quotation follow-up uses the shared Lost reason workflow without a manual Won action', async ({ page }) => {
  const lead = await retiredNotebookRedirect(page, '/notebook/furniture/quotation-follow-up', 'followups', 'third-floor');
  await expect(page.getByRole('button', { name: /mark.*won/i })).toHaveCount(0);
  await page.route('**/api/followups/retained-customer/contact', route => route.fulfill({ json: { channel: 'call', phone: '9000000000' } }));
  const writes: any[] = [];
  await page.route('**/api/followups/retained-customer/log-call', route => {
    expect(route.request().headers()['x-floor-id']).toBe('third-floor');
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...lead, status: 'done' } });
  });
  await page.getByTestId((page.viewportSize()?.width || 0) < 768 ? 'contact-retained-customer' : 'call-retained-customer').click();
  const dialog = page.getByRole('dialog', { name: 'Log Call Outcome', exact: true });
  await page.getByTestId('outcome-lost').click();
  await expect(page.getByTestId('save-call-outcome')).toBeDisabled();
  expect(writes).toHaveLength(0);
  await page.getByTestId('outcome-notes').fill('Client chose another vendor');
  await page.getByTestId('save-call-outcome').click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ outcome: 'lost', notes: 'Client chose another vendor' }]);
});

test('critical a routine call has no note field and only Lost requests a reason', async ({ page }) => {
  await mockSession(page, '/followups');
  await page.route('**/api/followups/assignees?**', r => r.fulfill({ json: [{ id: 'eligible-worker', full_name: 'Eligible worker', role: 'sales', floor_ids: ['first-floor'] }] }));
  await page.route('**/api/followups/config/assignees', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/page?**', r => r.fulfill({ json: { items: [row], page: 1, page_size: 100, has_more: false } }));
  const contacts: any[] = [], outcomes: any[] = [];
  await page.route('**/api/followups/note-required/contact', r => {
    contacts.push(r.request().postDataJSON());
    return r.fulfill({ json: { channel: 'call', phone: '9000000000' } });
  });
  await page.route('**/api/followups/note-required/log-call', r => {
    outcomes.push(r.request().postDataJSON());
    return r.fulfill({ json: row });
  });
  await page.goto('/followups');
  const phone = (page.viewportSize()?.width || 0) < 768;
  await page.getByTestId(phone ? 'contact-note-required' : 'call-note-required').click();
  const dialog = page.getByRole('dialog', { name: 'Log Call Outcome', exact: true });
  await expect(dialog).toBeVisible();
  await page.getByTestId('outcome-interested').click();
  await expect(page.getByTestId('outcome-notes')).toHaveCount(0);
  await expect(page.getByTestId('save-call-outcome')).toBeEnabled();
  await page.getByTestId('outcome-lost').click();
  await expect(page.getByTestId('outcome-notes')).toBeVisible();
  await expect(page.getByTestId('save-call-outcome')).toBeDisabled();
  await page.getByTestId('outcome-notes').fill('Cannot afford this service');
  await page.getByTestId('outcome-no_answer').click();
  await expect(page.getByTestId('outcome-notes')).toHaveCount(0);
  await page.getByTestId('save-call-outcome').click();
  await expect(dialog).toHaveCount(0);
  expect(contacts).toEqual([{ channel: 'call' }]);
  expect(outcomes).toEqual([{ outcome: 'no_answer' }]);
});

test('critical walk-in notes are read-only until marking the customer lost', async ({ page }) => {
  await mockSession(page, '/walkins/lost-client');
  let walkin = {
    id: 'lost-client', number: 'WI-LOST', customer_id: 'client-1', customer_name: 'Loss customer',
    customer_phone: '9000000000', floor_id: 'first-floor', salesperson_id: 'audit-owner', salesperson_name: 'Audit Owner',
    source: 'Walk-in', status: 'new', interested_products: [], notes: 'Previous visit note',
    visited_at: '2026-10-13T10:00:00Z', created_at: '2026-10-13T10:00:00Z', updated_at: '2026-10-13T10:00:00Z',
  };
  const writes: any[] = [];
  await page.route('**/api/walkins/lost-client/timeline', r => r.fulfill({ json: [] }));
  await page.route('**/api/walkins/lost-client', r => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON(); writes.push(body); walkin = { ...walkin, ...body };
    }
    return r.fulfill({ json: walkin });
  });
  await page.goto('/walkins/lost-client');
  await expect(page.getByText('Previous visit note', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Notes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark Contacted', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark Converted', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.getByTestId('walkin-mark-lost').click();
  const dialog = page.getByRole('dialog', { name: 'Mark as lost', exact: true });
  await expect(page.getByTestId('walkin-confirm-lost')).toBeDisabled();
  await page.getByTestId('walkin-lost-reason').fill('Cannot afford the service');
  await page.getByTestId('walkin-confirm-lost').click();
  await expect(dialog).toHaveCount(0);
  expect(writes[0]).toEqual({ status: 'lost', notes: 'Cannot afford the service' });
});

test('critical Won orders shows orders attributed to the current team member', async ({ page }) => {
  await mockSession(page, '/followups');
  await page.route('**/api/followups/assignees?**', r => r.fulfill({ json: [{ id: 'eligible-worker', full_name: 'Eligible worker', role: 'sales', floor_ids: ['first-floor'] }] }));
  await page.route('**/api/followups/config/assignees', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', r => r.fulfill({ json: [] }));
  const filters: URLSearchParams[] = [];
  await page.route('**/api/followups/page?**', r => {
    const params = new URL(r.request().url()).searchParams; filters.push(params);
    return r.fulfill({ json: { items: params.get('view') === 'won' ? [
      { ...row, id: 'my-order', customer_name: 'My placed order', assigned_to: 'audit-owner', status: 'done', auto_resolved: true, completed_outcome: 'won', bucket: 'completed' },
      { ...row, id: 'other-order', customer_name: 'Another salesperson order', assigned_to: 'other-user', status: 'done', auto_resolved: true, completed_outcome: 'won', bucket: 'completed' },
    ] : [], page: 1, page_size: 100, has_more: false } });
  });
  await page.goto('/followups');
  await page.getByRole('tab', { name: 'Won orders', exact: true }).click();
  await expect(page.getByText('My placed order', { exact: true })).toBeVisible();
  await expect(page.getByText('Another salesperson order', { exact: true })).toHaveCount(0);
  await expect.poll(() => filters.at(-1)?.get('assigned_to')).toBe('audit-owner');
});
