import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const floorId of ['first-floor', 'ground-floor']) test(`critical ${floorId} intake uses the selected worker instead of the owner`, async ({ page }) => {
  await mockSession(page, '/walkins/new', false, { floorId });
  const worker = { id: 'sales-worker', full_name: 'Assigned Worker', role: 'worker', floor_ids: [floorId] };
  await page.route('**/api/walkins/config/sources', r => r.fulfill({ json: { sources: ['Walk-in'] } }));
  await page.route('**/api/walkins/config/assignees', r => r.fulfill({ json: [worker] }));
  await page.route('**/api/followups/assignees?**', r => r.fulfill({ json: [worker] }));
  await page.route('**/api/walkins/check-duplicate?**', r => r.fulfill({ json: { high: [], medium: [], low: [] } }));
  const writes: any[] = [];
  await page.route('**/api/walkins', r => {
    writes.push(r.request().postDataJSON());
    return r.fulfill({ status: 503, json: { detail: 'Retry with your selected worker' } });
  });
  await page.goto('/walkins/new');
  await expect(page.getByTestId('walkin-salesperson-row')).toHaveCount(0);
  await page.getByTestId('walkin-name').fill('Sanitary visitor');
  await page.getByTestId('walkin-phone').fill('9000000000');
  await page.getByTestId('walkin-save-btn').click();
  await expect(page.getByTestId('walkin-submit-error')).toContainText('Salesperson is required');
  expect(writes).toEqual([]);
  await page.getByTestId(`lead-assign-${floorId}-sales-worker`).click();
  await page.getByTestId('walkin-save-btn').click();
  await expect(page.getByTestId('walkin-submit-error')).toContainText('Retry with your selected worker');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ salesperson_id: worker.id, assignments: [{ floor_id: floorId, user_id: worker.id }] });
  await expect(page.getByTestId(`lead-assign-${floorId}-sales-worker`)).toHaveAttribute('aria-pressed', 'true');
});

test('critical sanitary quotations group every unplaced quotation under Draft', async ({ page }) => {
  await mockSession(page, '/quotations', false);
  await page.route('**/api/quotations?**', r => r.fulfill({ json: ['draft', 'pending_approval', 'sent'].map((status, i) => ({
    id: `draft-${i}`, number: `Q-${i}`, customer_name: `Draft customer ${i}`, status,
    grand_total: 1234567, created_at: '2026-10-20T09:00:00Z', items: [],
  })) }));
  await page.goto('/quotations');
  await expect(page.getByTestId('filter-pending_approval')).toHaveCount(0);
  await expect(page.getByTestId('filter-sent')).toHaveCount(0);
  const draft = page.getByTestId('filter-draft');
  await draft.click();
  for (let i = 0; i < 3; i++) await expect(page.getByTestId(`quotation-draft-${i}`)).toBeVisible();
  await expect(page.getByTestId('quotations-lifecycle-toggle')).toHaveText('Completed');
});
