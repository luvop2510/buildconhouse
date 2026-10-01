import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const row = {
  id: 'note-required', customer_id: 'client-1', customer_name: 'Note Required Customer',
  customer_tier: 'retail', customer_phone: '9000000000', rule_type: 'manual', category: 'general',
  value: 12000, reason: 'Confirm delivery', reason_factors: [], next_action: 'Call customer',
  suggested_channel: 'call', priority_score: 70, priority_level: 'high', due_at: new Date().toISOString(),
  status: 'open', is_automated: false, auto_resolved: false, contact_attempts: 0, tags: [], bucket: 'today',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), assigned_to: 'audit-owner',
};

test('critical Follow-ups Done requires a note and preserves the task after cancel or failed save', async ({ page }) => {
  await mockSession(page, '/followups');
  await page.route('**/api/followups/config/assignees', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/saved-views', r => r.fulfill({ json: [] }));
  await page.route('**/api/followups/page?**', r => r.fulfill({ json: { items: [row], page: 1, page_size: 100, has_more: false } }));
  const writes: any[] = [];
  let fail = true;
  await page.route('**/api/followups/note-required/complete', r => {
    writes.push(r.request().postDataJSON());
    return fail ? r.fulfill({ status: 503, json: { detail: 'Could not save the follow-up' } })
      : r.fulfill({ json: { ...row, status: 'done', bucket: 'completed', notes: writes.at(-1).notes } });
  });
  await page.goto('/followups');
  await page.getByTestId('complete-note-required').click();
  const dialog = page.getByRole('dialog', { name: 'Complete follow-up', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('save-followup-change')).toBeDisabled();
  expect(writes).toHaveLength(0);
  await page.getByTestId('followup-change-note').fill(' \n ');
  await expect(page.getByTestId('save-followup-change')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await expect(page.getByTestId('complete-note-required')).toBeVisible();
  await page.getByTestId('complete-note-required').click();
  await page.getByTestId('followup-change-note').fill('Customer confirmed delivery and no further action is needed');
  await page.getByTestId('save-followup-change').click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save the follow-up');
  await expect(page.getByTestId('followup-change-note')).toHaveValue('Customer confirmed delivery and no further action is needed');
  expect(writes).toHaveLength(1);
  fail = false;
  await page.getByTestId('save-followup-change').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('complete-note-required')).toHaveCount(0);
  expect(writes).toEqual([
    { notes: 'Customer confirmed delivery and no further action is needed' },
    { notes: 'Customer confirmed delivery and no further action is needed' },
  ]);
});

test('critical dashboard Done stages a note before removing its task', async ({ page }) => {
  await mockSession(page, '/dashboard');
  await page.route('**/api/followups?limit=12', r => r.fulfill({ json: [row] }));
  const writes: any[] = [];
  await page.route('**/api/followups/note-required/complete', r => {
    writes.push(r.request().postDataJSON());
    return r.fulfill({ json: { ...row, status: 'done' } });
  });
  await page.goto('/dashboard');
  const queueRow = page.getByLabel('Note Required Customer, Call customer', { exact: true });
  await queueRow.hover();
  await queueRow.getByRole('button', { name: /done|complete/i }).click();
  await expect(page.getByTestId('save-followup-change')).toBeDisabled();
  expect(writes).toHaveLength(0);
  await page.getByTestId('followup-change-note').fill('Customer confirmed that the delivery is complete');
  await page.getByTestId('save-followup-change').click();
  await expect(queueRow).toHaveCount(0);
  expect(writes).toEqual([{ notes: 'Customer confirmed that the delivery is complete' }]);
});

test('critical notebook Won requires an action note before closing its lead', async ({ page }) => {
  await mockSession(page, '/notebook/kitchen/quotation-follow-up');
  const lead = {
    id: 'lead-one', customer_name: 'Kitchen customer', customer_phone: '9000000000', address: '',
    kitchen_type: 'GI', referred_by: '', referrer_id: null, referrer_name: '', referrer_type: null,
    architect_interior_designer: '', status: 'pending', notes: 'Previous discussion', lost_reason: '',
    is_converted: true, converted_at: '2026-09-01T12:00:00Z', last_contacted_at: null, contact_attempts: 0,
    updated_at: '2026-09-01T12:00:00Z', quotation_price: 12000,
  };
  await page.route('**/api/followups/notebook/second-floor?**', r => r.fulfill({ json: { rows: [lead], next_cursor: null } }));
  const writes: any[] = [];
  await page.route('**/api/followups/notebook/second-floor/lead-one/outcome', r => {
    writes.push(r.request().postDataJSON());
    return r.fulfill({ json: { ...lead, status: 'won', notes: writes.at(-1).notes } });
  });
  await page.goto('/notebook/kitchen/quotation-follow-up');
  await page.getByRole('button', { name: 'Mark won', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark client as won', exact: true });
  await expect(dialog.getByRole('button', { name: 'Mark as won', exact: true })).toBeDisabled();
  expect(writes).toHaveLength(0);
  await dialog.getByLabel('Follow-up note *', { exact: true }).fill('Client accepted the quotation and paid the advance');
  await dialog.getByRole('button', { name: 'Mark as won', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ outcome: 'won', updated_at: lead.updated_at, notes: 'Client accepted the quotation and paid the advance' }]);
});
