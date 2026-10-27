import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical sales reference directory creates, edits and reuses one identity across floors', async ({ page }) => {
  await mockSession(page, '/sales-data/referrals/architects', false, { seedStorageOnce: true });
  let reference: any = null;
  const floors = new Set<string>();
  await page.route('**/api/referrers**', async route => {
    const request = route.request();
    floors.add(request.headers()['x-floor-id'] || '');
    if (request.method() === 'POST') {
      reference = { ...request.postDataJSON(), id: 'shared-reference', floor_id: 'first-floor', shared_across_floors: true, updated_at: 'v1' };
      return route.fulfill({ json: reference });
    }
    if (request.method() === 'PUT') {
      expect(request.url()).toContain('/referrers/shared-reference');
      expect(request.postDataJSON().updated_at).toBe('v1');
      reference = { ...reference, ...request.postDataJSON(), updated_at: 'v2' };
      return route.fulfill({ json: reference });
    }
    return route.fulfill({ json: reference ? [reference] : [] });
  });
  await page.route('**/api/analytics/workspaces/relationships?**', route => route.fulfill({ json: { workspace: 'architects', period: 'This month', kpis: { revenue: 0, orders: 0, outstanding: 0 }, brands: [], products: [], customers: [], floors: [], relationships: [] } }));
  await page.goto('/sales-data/referrals/architects');
  const directory = page.getByTestId('sales-reference-directory');
  await directory.getByRole('button', { name: 'Add reference', exact: true }).click();
  await page.getByTestId('reference-name').fill('Shared Architect');
  await page.getByTestId('reference-company').fill('One Studio');
  await page.getByTestId('reference-phone').fill('9876543210');
  await page.getByRole('dialog').getByRole('button', { name: 'Save reference', exact: true }).click();
  await expect(directory).toContainText('Shared Architect · One Studio');
  await directory.getByRole('button', { name: 'Edit Shared Architect', exact: true }).click();
  await page.getByTestId('reference-company').fill('Updated Studio');
  await page.getByRole('dialog').getByRole('button', { name: 'Save reference', exact: true }).click();
  await expect(directory).toContainText('Shared Architect · Updated Studio');
  await page.evaluate(() => localStorage.setItem('forge.active-floor', JSON.stringify('ground-floor')));
  await page.reload();
  await expect(page.getByTestId('sales-reference-directory')).toContainText('Shared Architect · Updated Studio');
  await expect(page.getByTestId('sales-reference-directory')).toContainText('All floors');
  expect(floors.has('first-floor')).toBe(true);
  expect(floors.has('ground-floor')).toBe(true);
  expect(reference.id).toBe('shared-reference');
});
