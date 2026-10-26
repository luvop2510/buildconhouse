import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const lead = {
  id: 'scope-lead', customer_id: 'client', customer_name: 'Multi-floor client', floor_id: 'first-floor',
  interested_floor_ids: ['first-floor'], assignments: [], customer_tier: 'retail', customer_phone: '9000000000',
  rule_type: 'manual', category: 'general', value: 0, reason: 'Discuss samples', reason_factors: [],
  next_action: 'Call customer', suggested_channel: 'call', priority_score: 50, priority_level: 'medium',
  due_at: new Date().toISOString(), status: 'open', is_automated: false, contact_attempts: 0, tags: [], bucket: 'today',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};
const workers = [
  { id: 'worker-a', full_name: 'Sanitary staff', role: 'sales', floor_ids: ['first-floor'] },
  { id: 'worker-b', full_name: 'Both floors staff', role: 'sales', floor_ids: ['first-floor', 'ground-floor'] },
  { id: 'worker-c', full_name: 'Kitchen worker', role: 'worker', floor_ids: ['second-floor'] },
  { id: 'worker-d', full_name: 'Furniture worker', role: 'worker', floor_ids: ['third-floor'] },
];

async function mockLeads(page: Parameters<typeof mockSession>[0]) {
  await mockSession(page, '/followups');
  await page.route('**/api/followups/config/assignees', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/page?**', r => r.fulfill({ json: { items: [lead], page: 1, page_size: 100, has_more: false } }));
  await page.route('**/api/followups/assignees?**', r => r.fulfill({ json: workers }));
}

test('critical follow-up Interested retains multiple floors and multiple eligible assignees after a failed save', async ({ page }) => {
  await mockLeads(page);
  const writes: any[] = [];
  let fail = true;
  await page.route('**/api/followups/scope-lead/interests', r => {
    writes.push(r.request().postDataJSON());
    return fail ? r.fulfill({ status: 503, json: { detail: 'Please retry' } }) : r.fulfill({ json: lead });
  });
  await page.goto('/followups');
  await page.getByTestId('interested-scope-lead').click();
  const dialog = page.getByRole('dialog', { name: 'Interested floors & team assignment', exact: true });
  await dialog.getByTestId('lead-floor-ground-floor').click();
  await expect(dialog.getByTestId('lead-assign-ground-floor-worker-a')).toHaveCount(0);
  await dialog.getByTestId('lead-assign-first-floor-worker-a').click();
  await dialog.getByTestId('lead-assign-first-floor-worker-b').click();
  await dialog.getByTestId('lead-assign-ground-floor-worker-b').click();
  await dialog.getByTestId('lead-reference-source').fill('Interior studio referral');
  await dialog.getByTestId('lead-scope-save').click();
  await expect(dialog.getByText("Please retry", { exact: true })).toBeVisible();
  expect(writes[0].interested_floor_ids).toEqual(['first-floor', 'ground-floor']);
  expect(writes[0].assignments).toHaveLength(3);
  await expect(dialog.getByTestId('lead-assign-first-floor-worker-a')).toHaveAttribute('aria-pressed', 'true');
  fail = false;
  await dialog.getByTestId('lead-scope-save').click();
  await expect(dialog).toHaveCount(0);
  expect(writes[1]).toEqual(writes[0]);
});

test('critical adding a follow-up exposes only pre-order types and saves all selected floors', async ({ page }) => {
  await mockLeads(page);
  await page.route('**/api/followups/config/customers', r => r.fulfill({ json: [{ id: 'client', name: 'Multi-floor client', tier: 'retail' }] }));
  const writes: any[] = [];
  await page.route('**/api/followups', r => r.fulfill({ json: (writes.push(r.request().postDataJSON()), lead) }));
  await page.goto('/followups');
  await page.getByTestId('new-followup-btn').click();
  const dialog = page.getByRole('dialog', { name: 'New Follow-up', exact: true });
  await dialog.getByText('Multi-floor client', { exact: true }).click();
  await expect(dialog.getByText('Sales', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Payment', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Dispatch', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Delivery', { exact: true })).toHaveCount(0);
  await dialog.getByTestId('new-followup-reason').fill('Discuss flooring samples');
  await dialog.getByTestId('lead-floors-all').click();
  await dialog.getByTestId('create-followup').click();
  await expect(dialog).toBeVisible();
  expect(writes).toHaveLength(0);
  await dialog.getByTestId('lead-assign-first-floor-worker-a').click();
  await dialog.getByTestId('lead-assign-ground-floor-worker-b').click();
  await dialog.getByTestId('lead-assign-second-floor-worker-c').click();
  await dialog.getByTestId('create-followup').click();
  expect(writes).toHaveLength(0);
  await dialog.getByTestId('lead-assign-third-floor-worker-d').click();
  await dialog.getByTestId('create-followup').click();
  await expect(dialog).toHaveCount(0);
  expect(writes[0].interested_floor_ids).toHaveLength(4);
  expect(writes[0].assignments).toEqual([
    expect.objectContaining({ floor_id: 'first-floor', user_id: 'worker-a' }),
    expect.objectContaining({ floor_id: 'ground-floor', user_id: 'worker-b' }),
    expect.objectContaining({ floor_id: 'second-floor', user_id: 'worker-c' }),
    expect.objectContaining({ floor_id: 'third-floor', user_id: 'worker-d' }),
  ]);
});

test('critical new follow-up can add a customer with a mobile number', async ({ page }) => {
  await mockLeads(page);
  const writes: any[] = [];
  await page.route('**/api/followups', r => r.fulfill({ json: (writes.push(r.request().postDataJSON()), lead) }));
  await page.goto('/followups');
  await page.getByTestId('new-followup-btn').click();
  const dialog = page.getByRole('dialog', { name: 'New Follow-up', exact: true });
  await dialog.getByText('New customer', { exact: true }).click();
  await dialog.getByTestId('new-followup-customer-name').fill('New walk-in customer');
  await dialog.getByTestId('new-followup-customer-mobile').fill('9876543210');
  await dialog.getByTestId('new-followup-reason').fill('Discuss flooring samples');
  await dialog.getByTestId('lead-assign-first-floor-worker-a').click();
  await dialog.getByTestId('create-followup').click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ new_customer_name: 'New walk-in customer', new_customer_phone: '9876543210' });
  expect(writes[0]).not.toHaveProperty('customer_id');
});

test('critical team assign displays worker workload, responses and activity across selected floors', async ({ page }) => {
  await mockSession(page, '/team-assign');
  await page.route('**/api/followups/team-assign?**', r => r.fulfill({ json: {
    workers: [{ user_id: 'worker-a', user_name: 'Sanitary staff', assigned_leads: 3, contacts_made: 7, calls_made: 5, completed_leads: 1,
      leads: [{ id: 'scope-lead', customer_name: 'Multi-floor client', floor_id: 'first-floor', status: 'open', contact_attempts: 2, call_attempts: 2,
        latest_response: 'Interested in kitchen and sanitary samples', latest_update: 'Samples requested', activity: [{ description: 'Called customer', response: 'Please share samples' }] }] }],
    has_more: false, page: 1, page_size: 50,
  } }));
  await page.goto('/team-assign');
  const worker = page.getByTestId('team-worker-worker-a');
  await expect(worker.getByText('3 leads assigned')).toBeVisible();
  await expect(worker.getByText('7 contacts')).toBeVisible();
  await expect(worker.getByText('5 calls')).toBeVisible();
  await expect(worker.getByText('1 completed')).toBeVisible();
  await page.getByTestId('team-lead-scope-lead').click();
  await expect(worker.getByText('Called customer · Please share samples')).toBeVisible();
});

test('critical retrying follow-up creation retains one draft identity and selected floors', async ({ page }) => {
  await mockLeads(page);
  await page.route('**/api/followups/config/customers', r => r.fulfill({ json: [{ id: 'client', name: 'Multi-floor client', tier: 'retail' }] }));
  const writes: any[] = [];
  await page.route('**/api/followups', r => {
    writes.push(r.request().postDataJSON());
    return writes.length === 1 ? r.fulfill({ status: 503, json: { detail: 'Please retry creation' } }) : r.fulfill({ json: lead });
  });
  await page.goto('/followups');
  await page.getByTestId('new-followup-btn').click();
  const dialog = page.getByRole('dialog', { name: 'New Follow-up', exact: true });
  await dialog.getByText('Multi-floor client', { exact: true }).click();
  await dialog.getByTestId('new-followup-reason').fill('Discuss flooring samples');
  await dialog.getByTestId('lead-floors-all').click();
  await dialog.getByTestId('create-followup').click();
  await expect(dialog).toBeVisible();
  expect(writes).toHaveLength(0);
  await dialog.getByTestId('lead-assign-first-floor-worker-a').click();
  await dialog.getByTestId('lead-assign-ground-floor-worker-b').click();
  await dialog.getByTestId('lead-assign-second-floor-worker-c').click();
  await dialog.getByTestId('create-followup').click();
  expect(writes).toHaveLength(0);
  await dialog.getByTestId('lead-assign-third-floor-worker-d').click();
  await dialog.getByTestId('create-followup').click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(dialog.getByTestId('new-followup-reason')).toHaveValue('Discuss flooring samples');
  await expect(dialog.getByTestId('lead-floors-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByTestId('create-followup')).toBeEnabled();
  await dialog.getByTestId('create-followup').click();
  await expect(dialog).toHaveCount(0);
  expect(writes[0].request_key).toEqual(expect.any(String));
  expect(writes[0].request_key.length).toBeGreaterThan(10);
  expect(writes[1]).toEqual(writes[0]);
});

test('critical shared Furniture follow-up Interested supports multiple floors with a named interior reference', async ({ page }) => {
  await mockSession(page, '/followups');
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('third-floor')));
  await page.route('**/api/followups/config/assignees', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', r => r.fulfill({ json: [] }));
  const notebookLead = { ...lead, floor_id: 'third-floor', interested_floor_ids: ['third-floor'], kitchen_type: 'GI', address: '', referred_by: '', referrer_id: 'studio', referrer_name: 'Design Studio', referrer_type: 'interior_designer', architect_interior_designer: '', status: 'pending', is_converted: true, quotation_price: 12000 };
  await page.route('**/api/followups/page?**', r => r.fulfill({ json: { items: [{ ...notebookLead, status: 'open' }], page: 1, page_size: 100, has_more: false } }));
  const assigneeReads: URLSearchParams[] = [];
  await page.route('**/api/followups/assignees?**', r => {
    assigneeReads.push(new URL(r.request().url()).searchParams);
    return r.fulfill({ json: [{ ...workers[1], floor_ids: ['first-floor', 'third-floor'] }] });
  });
  const writes: any[] = [];
  await page.route('**/api/followups/scope-lead/interests', r => r.fulfill({ json: (writes.push(r.request().postDataJSON()), lead) }));
  await page.goto('/followups');
  await page.getByTestId('interested-scope-lead').click();
  const dialog = page.getByRole('dialog', { name: 'Interested floors & team assignment', exact: true });
  await expect(dialog.getByText('Design Studio · INT-STUDIO', { exact: true })).toBeVisible();
  await dialog.getByTestId('lead-floor-first-floor').click();
  await dialog.getByTestId('lead-assign-first-floor-worker-b').click();
  expect(assigneeReads.at(-1)?.get('source_id')).toBe('scope-lead');
  await dialog.getByTestId('lead-scope-save').click();
  await expect(dialog).toHaveCount(0);
  expect(writes[0]).toMatchObject({ interested_floor_ids: ['third-floor', 'first-floor'], referrer_id: 'studio', assignments: [{ floor_id: 'first-floor', user_id: 'worker-b' }] });
});

test('critical team assign is owner-only and does not fetch team activity for staff', async ({ page }) => {
  await mockSession(page, '/team-assign', true, { staff: { id: 'staff', full_name: 'Worker', role: 'sales', active: true, floor_ids: ['first-floor'] } });
  let reads = 0;
  await page.route('**/api/followups/team-assign?**', r => { reads += 1; return r.fulfill({ json: { workers: [] } }); });
  await page.goto('/team-assign');
  await expect(page.getByText('Owner access only', { exact: true })).toBeVisible();
  expect(reads).toBe(0);
});

test('critical team assign floor filters and pagination retain aggregate worker totals and render ActivityEvent responses', async ({ page }) => {
  await mockSession(page, '/team-assign');
  const reads: URLSearchParams[] = [];
  await page.route('**/api/followups/team-assign?**', r => {
    const params = new URL(r.request().url()).searchParams; reads.push(params);
    const pageNumber = Number(params.get('page') || 1);
    return r.fulfill({ json: { workers: [{ user_id: 'worker-a', user_name: 'Sanitary staff', assigned_leads: 60, contacts_made: 100, calls_made: 80, completed_leads: 10,
      leads: [{ id: `lead-${pageNumber}`, customer_name: `Client page ${pageNumber}`, floor_id: 'first-floor', status: 'open', contact_attempts: 2, call_attempts: 1, latest_response: 'Need samples', activity: [{ event_type: 'followup_call_logged', summary: 'Discussed flooring', actor_name: 'Sanitary staff', payload: { response: 'Please share kitchen samples' } }] }] }], has_more: pageNumber === 1, page: pageNumber, page_size: 50 } });
  });
  await page.goto('/team-assign');
  await expect(page.getByText('60 leads assigned')).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('60 leads assigned')).toBeVisible();
  await page.getByTestId('team-lead-lead-2').click();
  await expect(page.getByText('Discussed flooring · Sanitary staff · Please share kitchen samples')).toBeVisible();
  await page.getByRole('button', { name: 'The Sanitary Bathroom', exact: true }).click();
  await expect.poll(() => reads.at(-1)?.get('floor_ids')).toBe('first-floor');
  await expect.poll(() => reads.at(-1)?.get('page')).toBe('1');
});


test('critical sanitary salesperson filter stays within the panel and scrolls to the last employee', async ({ page }) => {
  await mockLeads(page);
  const owners = Array.from({ length: 30 }, (_, index) => ({ id: `owner-filter-${index}`, full_name: `Employee ${index + 1}`, role: 'worker' }));
  await page.route('**/api/followups/config/assignees', r => r.fulfill({ json: owners }));
  await page.goto('/followups');
  await expect(page.getByTestId('followups-filters-toggle')).toHaveCount(0);
  const first = page.getByTestId('followups-salesperson-all');
  await expect(first).toBeVisible();
  const scroller = first.locator('..').locator('..');
  const dimensions = await scroller.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: window.innerWidth }));
  expect(dimensions.content).toBeGreaterThan(dimensions.width);
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
  await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const last = page.getByTestId('followups-salesperson-owner-filter-29');
  await last.click();
  await expect(last).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('checkbox', { name: 'Sales', exact: true })).toHaveCount(0);
});

for (const inherited of [false, true]) {
  test(`critical successor reminder ${inherited ? 'retains an eligible selected worker' : 'requires a selected worker before saving'}`, async ({ page }) => {
    await mockLeads(page);
    const item = { ...lead, assigned_to: inherited ? 'worker-a' : null, assigned_to_name: inherited ? 'Sanitary staff' : null };
    await page.route('**/api/followups/page?**', r => r.fulfill({ json: { items: [item], page: 1, page_size: 100, has_more: false } }));
    await page.route('**/api/followups/scope-lead/contact', r => r.fulfill({ json: { channel: 'call', phone: '9000000000' } }));
    const writes: any[] = [];
    await page.route('**/api/followups/scope-lead/log-call', r => r.fulfill({ json: (writes.push(r.request().postDataJSON()), item) }));
    await page.goto('/followups');
    const contact = page.getByTestId((page.viewportSize()?.width || 0) < 768 ? 'contact-scope-lead' : 'call-scope-lead');
    await contact.click();
    const dialog = page.getByRole('dialog', { name: 'Log Call Outcome', exact: true });
    await dialog.getByTestId('outcome-call_back').click();
    if (!inherited) {
      await expect(dialog.getByTestId('save-call-outcome')).toBeDisabled();
      expect(writes).toHaveLength(0);
      await dialog.getByTestId('lead-assign-first-floor-worker-a').click();
    }
    await expect(dialog.getByTestId('lead-assign-first-floor-worker-a')).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByTestId('save-call-outcome').click();
    await expect(dialog).toHaveCount(0);
    expect(writes[0].outcome).toBe('call_back');
    if (!inherited) expect(writes[0].assignments).toEqual([expect.objectContaining({ floor_id: 'first-floor', user_id: 'worker-a' })]);
  });
}
