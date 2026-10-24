import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical Interior section displays acquired customers before an order is placed', async ({ page }) => {
  await mockSession(page, '/sales-data/referrals/interior-designers', false);
  await page.route('**/api/analytics/workspaces/interior-designers?**', route => route.fulfill({ json: {
    workspace: 'interior-designers', period: 'This month',
    kpis: { revenue: 0, orders: 0, outstanding: 0, hansgrohe_revenue: 0 },
    brands: [], products: [], customers: [], floors: [],
    relationships: [{ id: 'interior-acquisition', name: 'Sample Interior', company: 'Sample Studio', type: 'interior_designer',
      revenue: 0, orders: 0, customers: 0, customers_acquired: 7, last_order_at: null }],
  } }));
  await page.goto('/sales-data/referrals/interior-designers');
  await expect(page.getByText(/Through this interior, 7 customers were acquired\./).first()).toBeVisible();
  await expect(page.getByText(/Sample Studio/).first()).toBeVisible();
  await expect(page.getByText('No confirmed sales in this period', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
