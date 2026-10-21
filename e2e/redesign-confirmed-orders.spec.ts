import { expect, test } from '@playwright/test';
import { retiredNotebookRedirect } from './retired-notebook-fixtures';
import { mockSession } from './audit-fixtures';

for (const floor of [{ slug: 'kitchen', id: 'second-floor' }, { slug: 'furniture', id: 'third-floor' }]) {
  test(`critical ${floor.slug} quotation notebook redirects to active-floor shared follow-ups without a manual Won action`, async ({ page }) => {
    await retiredNotebookRedirect(page, `/notebook/${floor.slug}/quotation-follow-up`, 'followups', floor.id);
    await expect(page.getByRole('button', { name: /mark.*won/i })).toHaveCount(0);
    await expect(page.getByTestId('notebook-list')).toHaveCount(0);
    if (floor.id === 'second-floor') await expect(page.getByTestId('kitchen-search')).toBeVisible();
    else await expect(page.getByTestId('interested-retained-customer')).toBeVisible();
  });
}

test('critical sent quotation offers Place Order without a manual Won transition', async ({ page }) => {
  await mockSession(page, '/quotations/confirmed-order', false);
  await page.route(/\/api\/quotations\/confirmed-order(?:\?.*)?$/, route => route.fulfill({ json: {
    id: 'confirmed-order', number: 'Q-105', status: 'sent', floor_id: 'first-floor', customer_name: 'Order customer',
    items: [{ id: 'line', sku: 'B-1', name: 'Basin', qty: 1, unit_price: 200, discount_pct: 0, room: 'Bathroom' }], rooms: ['Bathroom'],
    subtotal: 200, discount_total: 0, grand_total: 200, created_at: '2026-10-01T10:00:00Z', created_by_name: 'Audit Owner',
  } }));
  await page.route('**/api/quotations/confirmed-order/breakdown', route => route.fulfill({ json: { lines: [], totals: { subtotal: 200, discount_total: 0, grand_total: 200 }, project_discount_pct: 0, category_discounts: {} } }));
  await page.route('**/api/activity/quotation/confirmed-order', route => route.fulfill({ json: [] }));
  await page.route('**/api/purchase-orders?quotation_id=confirmed-order', route => route.fulfill({ json: [] }));
  await page.goto('/quotations/confirmed-order');
  await expect(page.getByTestId('place-order-btn')).toBeVisible();
  await expect(page.getByRole('button', { name: /mark.*won/i })).toHaveCount(0);
  await expect(page.getByTestId('advance-status')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
