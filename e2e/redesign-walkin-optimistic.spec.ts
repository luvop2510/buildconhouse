import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical walk-in status previews immediately and rolls back a failed save', async ({ page }) => {
  await mockSession(page, '/walkins/optimistic-walkin', false, { floorId: 'ground-floor' });
  const walkin = { id: 'optimistic-walkin', number: 'W-OPTIMISTIC', floor_id: 'ground-floor',
    customer_id: 'customer-one', customer_name: 'Optimistic visitor', customer_phone: '9990001111',
    status: 'new', salesperson_id: 'worker', salesperson_name: 'Showroom worker',
    visited_at: '2026-11-01T10:00:00Z', interested_products: [], source: 'Walk-in' };
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route('**/api/walkins/optimistic-walkin/timeline', route => route.fulfill({ json: [] }));
  await page.route('**/api/walkins/config/assignees', route => route.fulfill({ json: [] }));
  await page.route('**/api/walkins/optimistic-walkin', async route => {
    if (route.request().method() === 'PATCH') {
      writes += 1;
      await held;
      return route.fulfill({ status: 503, json: { detail: 'Fixture cannot confirm save' } });
    }
    return route.fulfill({ json: walkin });
  });
  await page.goto('/walkins/optimistic-walkin?floor_id=ground-floor');
  await expect(page.getByText('Status: new', { exact: true })).toBeVisible();
  await page.getByTestId('walkin-schedule-selection').click();
  await expect(page.getByText('Status: selection scheduled · Saving…', { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  release();
  await expect(page.getByText('Status: new', { exact: true })).toBeVisible();
  await expect(page.getByText(/previous walk-in status has been restored/)).toBeVisible();
  expect(writes).toBe(1);
});
