import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const floor of ['first-floor','ground-floor','third-floor']) {
  test(`critical payment deletion is scoped to ${floor}`, async ({ page }) => {
    await mockSession(page, '/payments', false, { floorId: floor });
    let deleted = false;
    await page.route('**/api/payments/history?**', route => route.fulfill({ json: { total: deleted ? 0 : 1, items: deleted ? [] : [{
      id:'payment-one', customer_id:'customer', customer_name:'Test customer', invoice_number:'Q-1', floor_id:floor,
      business_unit:floor, amount:100, mode:'cash', status:'completed', paid_at:'2026-10-20T10:00:00Z', outstanding_before:200, outstanding_after:100,
    }] } }));
    await page.route('**/api/payments/payment-one', route => {
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().headers()['x-floor-id']).toBe(floor);
      deleted = true;
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('/payments');
    await page.getByTestId('payments-tabs-history').click();
    await expect(page.getByTestId('history-row-payment-one')).toBeVisible();
    if (floor === 'third-floor') await expect(page.getByTestId('delete-payment-payment-one')).toHaveCount(0);
    else {
      await page.getByTestId('delete-payment-payment-one').click();
      await expect(page.getByTestId('history-row-payment-one')).toHaveCount(0);
      await expect(page).toHaveURL(/\/payments$/);
      expect(deleted).toBe(true);
    }
  });
}
