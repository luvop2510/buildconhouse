import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const outcomes = {
  lost: { id: 'q-lost-import', number: 'Q-LOST-IMPORT', customer_name: 'Lost Imported Customer', customer_outcome: 'lost' },
  won: { id: 'q-won-import', number: 'Q-WON-IMPORT', customer_name: 'Won Imported Customer', customer_outcome: 'won' },
};
const quotationFixture = (outcome: keyof typeof outcomes) => ({
  ...outcomes[outcome], customer_id: `customer-${outcome}`, status: 'draft', grand_total: 500,
  created_at: '2026-09-19T10:00:00Z', revision_count: 0, rooms: ['Master Bath'], items: [],
});

async function builderPanel(page: Page) {
  const exit = page.getByTestId('expand-quotation-workspace');
  if (await exit.isVisible()) await exit.click();
  if (await page.getByTestId('builder-quotation-view-lost').isVisible()) return page;
  const actions = page.getByTestId('builder-actions');
  if (await actions.isVisible()) {
    await actions.click();
    await page.getByTestId('quotation-actions-sheet').getByRole('button', { name: 'Recent quotations', exact: true }).click();
    await expect(page.getByTestId('builder-recent-sheet')).toBeVisible();
    return page.getByTestId('builder-recent-sheet');
  }
  await page.getByRole('button', { name: 'Recent quotations', exact: true }).click();
  await expect(page.getByTestId('builder-recent-sheet')).toBeVisible();
  return page.getByTestId('builder-recent-sheet');
}

test('critical quotation builder finds imported lost and won customers beyond recent drafts and restores their quotation', async ({ page }) => {
  await mockSession(page, '/quotations/new', false);
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  const requests: { view: string | null; floor: string | undefined }[] = [];
  let failLost = true;
  await page.route('**/api/quotations/recent?**', route => {
    const view = new URL(route.request().url()).searchParams.get('view');
    requests.push({ view, floor: route.request().headers()['x-floor-id'] });
    if (view === 'lost' && failLost) return route.fulfill({ status: 503, json: { detail: 'Temporary outcome error' } });
    return route.fulfill({ json: view === 'lost' || view === 'won' ? [quotationFixture(view)] : [] });
  });
  await page.route(/\/api\/quotations\/q-won-import(?:\?.*)?$/, route => route.fulfill({ json: quotationFixture('won') }));
  await page.goto('/quotations/new');
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  const panel = await builderPanel(page);
  await panel.getByTestId('builder-quotation-view-lost').click();
  await expect(panel.getByTestId('builder-quotation-outcome-retry')).toBeVisible();
  failLost = false;
  await panel.getByTestId('builder-quotation-outcome-retry').click();
  const lost = panel.getByTestId('rail-recent-Q-LOST-IMPORT');
  await expect(lost).toContainText('Lost Imported Customer');
  await expect(lost.getByText('Lost', { exact: true })).toBeVisible();
  await panel.getByTestId('builder-quotation-view-won').click();
  await expect(lost).toHaveCount(0);
  const won = panel.getByTestId('rail-recent-Q-WON-IMPORT');
  await expect(won).toContainText('Won Imported Customer');
  await expect(won.getByText('Won', { exact: true })).toBeVisible();
  await won.click();
  await expect(page.getByText('Restored Q-WON-IMPORT', { exact: true })).toBeVisible();
  await expect(page.getByTestId('builder-customer-outcome')).toContainText('Won Customer recorded');
  await expect(page.getByTestId('place-order')).toHaveCount(0);
  expect(requests.filter(request => request.view).every(request => request.floor === 'first-floor')).toBe(true);
  await panel.getByTestId('builder-quotation-view-all').click();
  await expect(page).toHaveURL(/\/quotations\?view=won$/);
});

test('critical quotation Lost Customer and Won Customer pages request terminal views without completion or draft filters', async ({ page }, info) => {
  await mockSession(page, '/quotations', false);
  const queries: URLSearchParams[] = [];
  await page.route('**/api/quotations?**', route => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    const view = params.get('view');
    return route.fulfill({ json: view === 'lost' || view === 'won' ? [quotationFixture(view)] : [] });
  });
  await page.goto('/quotations');
  await page.getByTestId('quotations-lost-toggle').click();
  await expect(page.getByText('Lost Customer · Quotations', { exact: true })).toBeVisible();
  await expect(page.getByTestId('quotation-q-lost-import')).toContainText('Lost');
  await expect(page.getByTestId('quotation-q-won-import')).toHaveCount(0);
  await expect(page.getByTestId('filter-draft')).toHaveCount(0);
  if (['desktop', 'phone'].includes(info.project.name)) await page.screenshot({ path: info.outputPath('customer-outcomes-lost.png'), fullPage: true });
  await page.getByTestId('quotations-won-toggle').click();
  await expect(page.getByText('Won Customer · Quotations', { exact: true })).toBeVisible();
  await expect(page.getByTestId('quotation-q-won-import')).toContainText('Won');
  await expect(page.getByTestId('quotation-q-lost-import')).toHaveCount(0);
  if (['desktop', 'phone'].includes(info.project.name)) await page.screenshot({ path: info.outputPath('customer-outcomes-won.png'), fullPage: true });
  const terminal = queries.filter(params => ['won', 'lost'].includes(params.get('view') || ''));
  expect(terminal.map(params => params.get('view'))).toEqual(['lost', 'won']);
  expect(terminal.every(params => !params.has('completion') && !params.has('status'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical historical customer quotation detail keeps editing and exports while preventing a second order', async ({ page }) => {
  await mockSession(page, '/quotations/q-won-import', false);
  await page.route(/\/api\/quotations\/q-won-import(?:\?.*)?$/, route => route.fulfill({ json: {
    ...quotationFixture('won'), floor_id: 'first-floor', created_by_name: 'Audit Owner', subtotal: 500, discount_total: 0,
    items: [{ id: 'historical-line', sku: 'HISTORICAL', name: 'Imported fitting', qty: 1, unit_price: 500, discount_pct: 0, room: 'Master Bath' }],
  } }));
  await page.route('**/api/quotations/q-won-import/breakdown', route => route.fulfill({ json: {
    lines: [], totals: { subtotal: 500, discount_total: 0, grand_total: 500 }, project_discount_pct: 0, category_discounts: {},
  } }));
  await page.route('**/api/activity/quotation/q-won-import', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?quotation_id=q-won-import', route => route.fulfill({ json: [] }));
  await page.goto('/quotations/q-won-import');
  await expect(page.getByTestId('quotation-customer-outcome')).toContainText('Won Customer recorded');
  await expect(page.getByTestId('place-order-btn')).toHaveCount(0);
  await expect(page.getByTestId('edit-quotation')).toBeVisible();
  await expect(page.getByTestId('download-pdf')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
