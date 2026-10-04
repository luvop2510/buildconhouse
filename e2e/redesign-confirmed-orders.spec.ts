import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const floor of [{ slug: 'kitchen', id: 'second-floor' }, { slug: 'furniture', id: 'third-floor' }]) {
  test(`critical ${floor.slug} quotation notebook virtualizes long lists and offers no manual Won action`, async ({ page }, info) => {
    await mockSession(page, `/notebook/${floor.slug}/quotation-follow-up`, false);
    const rows = Array.from({ length: 120 }, (_, index) => ({
      id: `lead-${index}`, customer_name: `Fixture customer ${index}`, customer_phone: '9000000000', address: 'Project site',
      kitchen_type: 'GI', referred_by: '', referrer_id: null, referrer_name: '', referrer_type: null, architect_interior_designer: '',
      status: 'pending', notes: 'Confirm measurements', lost_reason: '', is_converted: true, converted_at: '2026-10-01T10:00:00Z',
      last_contacted_at: null, contact_attempts: 0, updated_at: '2026-10-01T10:00:00Z', quotation_price: 25000,
    }));
    await page.route(`**/api/followups/notebook/${floor.id}?**`, route => route.fulfill({ json: { rows, next_cursor: null } }));
    await page.goto(`/notebook/${floor.slug}/quotation-follow-up`);
    await expect(page.getByTestId('notebook-list')).toBeVisible();
    await expect(page.getByText('Fixture customer 0', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /mark.*won/i })).toHaveCount(0);
    await expect.poll(() => page.getByRole('button', { name: 'Call', exact: true }).count()).toBeLessThan(120);
    const mounted = await page.getByRole('button', { name: 'Call', exact: true }).count();
    await info.attach('virtualization-evidence', { body: `Mounted ${mounted} of 120 customer cards at ${page.viewportSize()!.width}px (previous ScrollView mounted 120).`, contentType: 'text/plain' });
    await page.getByRole('button', { name: 'Lost', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'Mark lead as lost', exact: true })).toBeVisible();
    await expect(page.getByLabel('Lost reason *', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('critical sent quotation offers Place Order without a manual Won transition', async ({ page }) => {
  await mockSession(page, '/quotations/confirmed-order', false);
  await page.route('**/api/quotations/confirmed-order', route => route.fulfill({ json: {
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
