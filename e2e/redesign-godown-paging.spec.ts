import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function stockFixture(page: Page) {
  await mockSession(page, '/godown-stock', false);
  const lots = Array.from({ length: 150 }, (_, i) => ({ id: `page-stock-${i}`, product_id: `godown:page-stock-${i}`, sku: `PAGED-${i}`,
    name: `Warehouse product ${i}`, brand_id: 'brand', brand_name: 'Grohe', qty_received: i === 0 ? 0 : 2,
    available_qty: i === 0 ? 0 : 2, transferable_qty: i === 0 ? 0 : 2, quantity_missing: i === 0,
    unit_price: 100, stock_value: i === 0 ? null : 200, updated_at: 'v1', history_loaded: false }));
  const requests: URL[] = [];
  await page.route('**/api/godown-stock?**', route => {
    const url = new URL(route.request().url()); requests.push(url);
    const matching = lots.filter(lot => `${lot.sku} ${lot.name}`.toLowerCase().includes((url.searchParams.get('q') || '').toLowerCase()));
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 2000);
    const total = lots.reduce((sum, lot) => sum + lot.available_qty, 0);
    return route.fulfill({ json: { lots: matching.slice(offset, offset + limit), brands: [{ id: 'brand', name: 'Grohe', lot_count: 150, available_qty: total }],
      total_available_qty: total, total_stock_value: total * 100, unpriced_lot_count: 0,
      ...(url.searchParams.has('limit') ? { total_lots: matching.length,
        available_lot_count: matching.filter(lot => lot.available_qty > 0).length, unknown_quantity_count: matching.filter(lot => lot.quantity_missing).length,
        zero_lot_count: matching.filter(lot => !lot.quantity_missing && lot.available_qty === 0).length,
        next_offset: offset + limit < matching.length ? offset + limit : null } : {}),
    } });
  });
  return { lots, requests };
}

test('critical stock paging bounds transport, retains drafts and finds products beyond loaded pages', async ({ page }, info) => {
  const { requests } = await stockFixture(page);
  await page.goto('/godown-stock');
  await expect(page.getByTestId('godown-lot-page-stock-0')).toBeVisible();
  await expect(page.getByTestId('godown-lot-page-stock-60')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get('limit')).toBe('60');
  expect(requests[0].searchParams.get('with_movements')).toBe('false');
  await page.getByTestId('godown-edit-page-stock-1').click();
  const draft = page.getByTestId('godown-price-page-stock-1');
  await draft.fill('333');
  await page.getByTestId('godown-load-more').click();
  await expect(page.getByTestId('godown-lot-page-stock-60')).toBeAttached();
  await expect(draft).toHaveValue('333');
  await page.getByTestId('godown-load-more').click();
  await expect(page.getByTestId('godown-lot-page-stock-149')).toBeAttached();
  expect(requests.map(url => url.searchParams.get('offset'))).toEqual(['0', '60', '120']);
  await page.getByRole('textbox', { name: 'Search godown stock', exact: true }).fill('PAGED-149');
  await expect(page.getByTestId('godown-results')).toContainText('showing 1 of 1');
  await expect(page.getByTestId('godown-lot-page-stock-149')).toBeVisible();
  await expect(page.getByTestId('godown-lot-page-stock-1')).toHaveCount(0);
  await expect(page.getByLabel('298 units available', { exact: true })).toBeAttached();
  expect(requests.at(-1)!.searchParams.get('q')).toBe('PAGED-149');
  await page.screenshot({ path: info.outputPath('paged-stock-server-search.png'), fullPage: true });
});

test('critical paged quantity updates preserve whole-floor totals and export all filtered inventory', async ({ page }) => {
  const { lots, requests } = await stockFixture(page);
  await page.route('**/api/godown-stock/page-stock-0/quantity-count', route => {
    lots[0] = { ...lots[0], quantity_missing: false, available_qty: 5, qty_received: 5, transferable_qty: 5, stock_value: 500, updated_at: 'v2' };
    return route.fulfill({ json: lots[0] });
  });
  let exportedRows: string[][] = [];
  await page.route('**/api/exports/page.xlsx', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    exportedRows = route.request().postDataJSON().sections[0].rows;
    return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from('synthetic export transport') });
  });
  await page.goto('/godown-stock');
  await page.getByTestId('godown-count-page-stock-0').click();
  await page.getByTestId('godown-count-qty-page-stock-0').fill('5');
  await page.getByTestId('godown-count-date-page-stock-0').fill('2026-10-24');
  await page.getByTestId('godown-count-reason-page-stock-0').fill('Confirmed physical count');
  await page.getByTestId('godown-count-save-page-stock-0').click();
  await expect(page.getByLabel('303 units available', { exact: true })).toBeAttached();
  await expect(page.getByRole('tab', { name: 'Grohe · 303', exact: true })).toBeAttached();
  await expect(page.getByTestId('godown-results')).toContainText('150 available');
  await page.getByTestId('godown-export-inventory').click();
  await expect.poll(() => exportedRows.length).toBe(151);
  expect(exportedRows.at(-1)![0]).toBe('PAGED-149');
  expect(requests.at(-1)!.searchParams.has('limit')).toBe(false);
  expect(requests.at(-1)!.searchParams.get('with_movements')).toBe('false');
});

test('critical movement history loads on demand, retries independently and continues past its first page', async ({ page }) => {
  const { lots } = await stockFixture(page);
  lots[0] = { ...lots[0], quantity_missing: false, qty_received: 200, available_qty: 79, transferable_qty: 79, stock_value: 7900 };
  let reads = 0;
  await page.route('**/api/godown-stock/page-stock-0/history?**', route => {
    reads += 1;
    if (reads === 1) return route.fulfill({ status: 503, json: { detail: 'Movement history temporarily unavailable' } });
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    return route.fulfill({ json: {
      allocations: offset === 0 ? Array.from({ length: 60 }, (_, i) => ({ id: `allocation-${i}`, qty: 1, quotation_id: `Q-${i}`, allocated_at: '2026-10-01T00:00:00Z' })) : [],
      customer_transfers: Array.from({ length: offset === 0 ? 60 : 1 }, (_, i) => ({ id: `transfer-${i + offset}`, qty: 1, recipient_customer_name: `History buyer ${i + offset}`, created_at: '2026-10-01T00:00:00Z' })),
      next_offset: offset === 0 ? 60 : null,
    } });
  });
  await page.goto('/godown-stock');
  const card = page.getByTestId('godown-lot-page-stock-0');
  await expect(card).toBeVisible();
  expect(reads).toBe(0);
  await card.getByRole('button', { name: 'Show stock history for Warehouse product 0', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Movement history temporarily unavailable');
  await expect(card.getByRole('button', { name: 'Transfer Warehouse product 0 to a customer', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Retry stock history for Warehouse product 0', exact: true }).click();
  await expect(card).toContainText('History buyer 59');
  await card.getByRole('button', { name: 'Load more stock history for Warehouse product 0', exact: true }).click();
  await expect(card).toContainText('History buyer 60');
  await expect(card.getByRole('button', { name: 'Load more stock history for Warehouse product 0', exact: true })).toHaveCount(0);
  expect(reads).toBe(3);
});
