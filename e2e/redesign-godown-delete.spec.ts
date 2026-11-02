import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const floor of ['first-floor','ground-floor','third-floor']) {
  test(`critical stock deletion respects ${floor}`, async ({ page }) => {
    await mockSession(page, '/godown-stock', false, { floorId: floor });
    let deleted = false;
    const lot = { id:'lot-one', product_id:'godown:lot-one', sku:'TEST', name:'Test stock', qty_received:2, available_qty:2, transferable_qty:2, unit_price:100, stock_value:200 };
    await page.route('**/api/godown-stock?**', route => route.fulfill({json:{lots:deleted ? [] : [lot], total_lots:deleted ? 0 : 1, total_available_qty:deleted ? 0 : 2, total_stock_value:deleted ? 0 : 200, brands:[], next_offset:null}}));
    await page.route('**/api/godown-stock/lot-one', route => {
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().headers()['x-floor-id']).toBe(floor);
      deleted = true;
      return route.fulfill({json:{ok:true}});
    });
    await page.goto('/godown-stock');
    await expect(page.getByText('Test stock', {exact:true})).toBeVisible();
    if (floor === 'third-floor') await expect(page.getByTestId('delete-stock-lot-one')).toHaveCount(0);
    else {
      await page.getByTestId('delete-stock-lot-one').click();
      await expect(page.getByText('Test stock', {exact:true})).toHaveCount(0);
      expect(deleted).toBe(true);
    }
  });
}
