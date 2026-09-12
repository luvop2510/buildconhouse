import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical desktop conversion insights recover instead of showing an indefinite skeleton', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockSession(page, '/followups');
  await page.route('**/api/followups/page?**', r => r.fulfill({ json: { items: [], page: 1, page_size: 100, has_more: false } }));
  await page.goto('/followups');
  await expect(page.getByText('Conversion insights are unavailable.', { exact: true })).toBeVisible();
  await page.route('**/api/followups/insights', r => r.fulfill({ json: { calls_completed: 3, whatsapps_sent: 2, payments_collected: 1200.5, quotations_approved: 1, response_rate: 50 } }));
  await page.getByRole('button', { name: 'Retry insights', exact: true }).click();
  await expect(page.getByText('Calls completed', { exact: true })).toBeVisible();
  await expect(page.getByText('50%', { exact: true })).toBeVisible();
  await expect(page.getByText('Conversion insights are unavailable.', { exact: true })).toHaveCount(0);
});
