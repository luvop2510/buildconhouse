import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical Furniture follow-up queue remains available when the optional summary fails', async ({ page }) => {
  await mockSession(page, '/followups');
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('third-floor')));
  let summaryRequests = 0;
  await page.route('**/api/followups/page?**', r => r.fulfill({ json: { items: [], page: 1, page_size: 100, has_more: false } }));
  await page.route('**/api/followups/stats', route => {
    summaryRequests += 1;
    return route.fulfill({ status: 503, json: { detail: 'Summary unavailable' } });
  });
  await page.goto('/followups');
  await expect(page.getByText("You're all caught up.", { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(summaryRequests).toBe(0);

  if (!await page.getByRole('button', { name: 'Summary', exact: true }).isVisible()) await page.getByTestId('followups-filters-toggle').click();
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(page.getByText("Today's Tasks", { exact: true })).toBeVisible();
  await expect.poll(() => summaryRequests).toBe(1);
  await expect(page.getByText("You're all caught up.", { exact: true })).toBeVisible();
});
