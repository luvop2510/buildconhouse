import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical Interior section displays acquired customers before an order is placed', async ({ page }) => {
  await mockSession(page, '/sales-data/referrals/interior-designers', false);
  await page.route('**/api/referrers/page?**', route => route.fulfill({json:{rows:[],total:0,offset:0,limit:25}}));
  await page.route('**/api/analytics/workspaces/relationships?**', route => route.fulfill({ json: {
    workspace: 'interior-designers', period: 'This month',
    kpis: { revenue: 0, orders: 0, outstanding: 0, hansgrohe_revenue: 0 },
    brands: [], products: [], customers: [], floors: [],
    relationships: [{ id: 'interior-acquisition', name: 'Sample Interior', company: 'Sample Studio', type: 'interior_designer',
      revenue: 0, orders: 0, customers: 0, customers_acquired: 7, last_order_at: null, historical: true }],
  } }));
  await page.goto('/sales-data/referrals/interior-designers');
  await expect(page.getByTestId('reference-row-interior-acquisition')).toContainText('7');
  await expect(page.getByText(/Sample Studio/).first()).toBeVisible();
  await expect(page.getByText('No confirmed sales in this period', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});


test('critical reference drilldown lists non-converted walk-ins and confirmed customers across a custom date range', async ({ page }, info) => {
  await mockSession(page, '/sales-data/referrer/interior-acquisition', false);
  const reads: URL[] = [];
  await page.route('**/api/sales-data/referrers/interior-acquisition?**', route => {
    const url = new URL(route.request().url()); reads.push(url);
    const filtered = url.searchParams.get('preset') === 'custom';
    return route.fulfill({ json: {
      referrer: { id: 'interior-acquisition', name: 'Sample Interior Studio', type: 'interior_designer', company: 'Sample Studio' },
      total_revenue: 100, trend: [], quotations: [], brands: [],
      customers_acquired: filtered ? 1 : 2, referred_people: [
        { customer_name: 'Non-converted walk-in', confirmed: 0, sources: ['walkins'], first_referred_at: '2026-10-12' },
        ...(!filtered ? [{ customer_name: 'Confirmed customer', confirmed: 1, sources: ['quotations', 'customers'], first_referred_at: '2026-10-01' }] : []),
      ],
    } });
  });
  await page.goto('/sales-data/referrer/interior-acquisition?floorId=first-floor&preset=all');
  await expect(page.getByTestId('referrer-clients')).toContainText('Clients brought · 2');
  await expect(page.getByTestId('referrer-clients')).toContainText('Non-converted walk-in');
  await expect(page.getByTestId('referrer-clients')).toContainText('Confirmed customer');
  const toggle = page.getByTestId('sales-data-filters-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByTestId('sales-data-period-picker').click();
  await page.getByTestId('sales-data-period-custom').click();
  await page.getByRole('textbox', { name: 'From', exact: true }).fill('2026-10-10');
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('2026-10-15');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(page.getByTestId('referrer-clients')).toContainText('Clients brought · 1');
  expect(reads.at(-1)?.searchParams.get('date_from')).toBe('2026-10-10T00:00:00+00:00');
  expect(reads.at(-1)?.searchParams.get('date_to')).toBe('2026-10-16T00:00:00+00:00');
  expect(reads.every(url => url.searchParams.get('floor_id') === 'first-floor')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('reference-all-clients-custom-range.png'), fullPage: true });
});
