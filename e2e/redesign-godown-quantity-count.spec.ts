import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const qty of [0, 5]) {
  test(`critical uncounted stock records an explicit ${qty} count with retry and updated totals`, async ({ page }, info) => {
    await mockSession(page, '/godown-stock', false);
    const initial = { id: 'count-lot', product_id: 'godown:count-lot', sku: 'COUNT', name: 'Uncounted mixer', brand_name: 'Grohe',
      quantity_missing: true, qty_received: 0, available_qty: 0, transferable_qty: 0, unit_price: 100, stock_value: null, updated_at: 'v1' };
    await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
      lots: [initial], brands: [{ name: 'Grohe', available_qty: 0, lot_count: 1 }], total_available_qty: 0, total_stock_value: 0, unpriced_lot_count: 0,
    } }));
    const commands: Record<string, unknown>[] = [];
    await page.route('**/api/godown-stock/count-lot/quantity-count', route => {
      expect(route.request().headers()['x-floor-id']).toBe('first-floor');
      const body = route.request().postDataJSON(); commands.push(body);
      return route.fulfill(commands.length === 1 ? { status: 504, json: { detail: 'Count response lost. Retry this count.' } } : {
        json: { ...initial, qty_received: qty, available_qty: qty, transferable_qty: qty, stock_value: qty * 100, quantity_missing: false, updated_at: 'v2', idempotent: true,
          quantity_counts: [{ id: 'count-1', qty, unit: 'product_stock_unit', counted_on: body.counted_on, reason: body.reason, actor_name: 'Audit Owner', recorded_at: '2026-10-24T12:00:00Z' }] },
      });
    });
    await page.goto('/godown-stock');
    const card = page.getByTestId('godown-lot-count-lot');
    await page.getByTestId('godown-count-count-lot').click();
    const save = page.getByTestId('godown-count-save-count-lot');
    await save.click();
    await expect(card.getByRole('alert')).toContainText('Enter the counted quantity');
    expect(commands).toHaveLength(0);
    await page.getByTestId('godown-count-qty-count-lot').fill(String(qty));
    await page.getByTestId('godown-count-date-count-lot').fill('2026-10-24');
    await page.getByTestId('godown-count-reason-count-lot').fill('Physical count of saleable units');
    await save.click();
    await expect(card.getByRole('alert')).toContainText('Count response lost');
    await expect(page.getByTestId('godown-count-qty-count-lot')).toHaveValue(String(qty));
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('quantity-count-retry.png'), fullPage: true });
    await save.click();
    await expect(save).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({ qty, counted_on: '2026-10-24', reason: 'Physical count of saleable units', expected_updated_at: 'v1' });
    await expect(card).toContainText(qty ? '5 in stock' : 'Out of stock · 0 units');
    await expect(page.getByLabel(`${qty} units available`, { exact: true })).toBeAttached();
    await expect(page.getByRole('tab', { name: `Grohe · ${qty}`, exact: true })).toBeAttached();
    await card.getByRole('button', { name: 'Show stock history for Uncounted mixer', exact: true }).click();
    await expect(card).toContainText(`Counted opening balance ${qty}`);
    await expect(card).toContainText(`Counted ${qty} stock units on 2026-10-24`);
  });
}

test('critical stale quantity count refreshes only its lot and preserves the entered count for review', async ({ page }) => {
  await mockSession(page, '/godown-stock', false);
  const initial = { id: 'stale-count', product_id: 'godown:stale-count', sku: 'STALE-COUNT', name: 'Stale count basin', brand_name: 'Grohe',
    quantity_missing: true, qty_received: 0, available_qty: 0, transferable_qty: 0, unit_price: 100, stock_value: null, updated_at: 'v1' };
  let reads = 0;
  await page.route('**/api/godown-stock?**', route => { reads += 1; return route.fulfill({ json: {
    lots: [initial], brands: [], total_available_qty: 0, total_stock_value: 0, unpriced_lot_count: 0,
  } }); });
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/godown-stock/stale-count/quantity-count', route => {
    const body = route.request().postDataJSON(); commands.push(body);
    return route.fulfill(commands.length === 1 ? { status: 409, json: { detail: 'Stock details changed. Reload and review this lot before recording the count.' } } : {
      json: { ...initial, qty_received: 3, available_qty: 3, transferable_qty: 3, quantity_missing: false, unit_price: 200, stock_value: 600, updated_at: 'v3' },
    });
  });
  await page.route('**/api/godown-stock/stale-count', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    return route.fulfill({ json: { ...initial, updated_at: 'v2', unit_price: 200 } });
  });
  await page.goto('/godown-stock');
  await page.getByTestId('godown-count-stale-count').click();
  await page.getByTestId('godown-count-qty-stale-count').fill('3');
  await page.getByTestId('godown-count-date-stale-count').fill('2026-10-24');
  await page.getByTestId('godown-count-reason-stale-count').fill('Physical count');
  const save = page.getByTestId('godown-count-save-stale-count');
  await save.click();
  await expect(page.getByRole('alert')).toContainText('Stock details changed');
  await page.getByRole('button', { name: 'Refresh quantity details for Stale count basin', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Stock refreshed');
  await expect(page.getByTestId('godown-count-qty-stale-count')).toHaveValue('3');
  await save.click();
  await expect(save).toHaveCount(0);
  expect(commands[0].expected_updated_at).toBe('v1');
  expect(commands[1].expected_updated_at).toBe('v2');
  expect(commands[1].idempotency_key).not.toBe(commands[0].idempotency_key);
  expect(reads).toBe(1);
  await expect(page.getByLabel('3 units available', { exact: true })).toBeAttached();
});
