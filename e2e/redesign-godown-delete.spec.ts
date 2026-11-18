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
      expect(deleted).toBe(false);
      await page.getByTestId('confirm-delete-godown-stock-confirm').click();
      await expect(page.getByText('Test stock', {exact:true})).toHaveCount(0);
      expect(deleted).toBe(true);
    }
  });
}

test('critical stock movement disappears after confirmation and the refreshed lot keeps other movements', async ({ page }) => {
  await mockSession(page, '/godown-stock', false, { floorId: 'ground-floor' });
  const target = { id: 'target-movement', occurred_on: '2026-10-20', kind: 'receipt', qty: 1, actor_name: 'Owner', reason: 'Duplicate intake' };
  const remaining = { ...target, id: 'remaining-movement', reason: 'Original intake' };
  const lot = { id:'lot-one', product_id:'godown:lot-one', sku:'TEST', name:'Test stock', qty_received:2, available_qty:2,
    transferable_qty:2, unit_price:100, stock_value:200, stock_movements:[target, remaining], history_loaded:true };
  let deletes = 0;
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots: [lot], total_lots: 1, total_available_qty: 2, total_stock_value: 200, brands: [], next_offset: null,
  } }));
  await page.route('**/api/godown-stock/lot-one', route => route.fulfill({ json: lot }));
  await page.route('**/api/godown-stock/lot-one/movements/target-movement', route => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    deletes++;
    lot.stock_movements = [remaining];
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/godown-stock');
  await page.getByRole('button', { name: 'Show stock history for Test stock' }).click();
  await page.getByTestId('delete-stock-movement-target-movement').click();
  expect(deletes).toBe(0);
  await page.getByTestId('confirm-delete-stock-movement-confirm').click();
  await expect(page.getByTestId('delete-stock-movement-target-movement')).toHaveCount(0);
  await expect(page.getByTestId('delete-stock-movement-remaining-movement')).toBeVisible();
  expect(deletes).toBe(1);
});
