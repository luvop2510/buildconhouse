import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical warehouse stock edits price and image and keeps unknown quantities visible', async ({ page }) => {
  await mockSession(page, '/godown-stock', false);
  let lot = { id: 'duravit-lot', product_id: 'duravit-product', sku: '2328480000',
    name: 'Cape Cod washbowl', brand_name: 'Duravit', qty_received: 2, available_qty: 2,
    transferable_qty: 2, unit_price: null as number | null, stock_value: null as number | null,
    image: null as string | null, source_type: 'warehouse_import', price_variants: [],
  };
  const unknown = { ...lot, id: 'unknown-lot', name: 'Uncounted basin', sku: 'UNCOUNTED',
    qty_received: 0, available_qty: 0, transferable_qty: 0, quantity_missing: true };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots: [lot, unknown], brands: [], total_available_qty: 2,
    total_stock_value: lot.stock_value || 0, unpriced_lot_count: lot.unit_price === null ? 1 : 0,
  } }));
  await page.route('**/api/godown-stock/duravit-lot/details', route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    lot = { ...lot, ...body, stock_value: body.unit_price === null ? null : body.unit_price * 2 };
    return route.fulfill({ json: lot });
  });
  await page.goto('/godown-stock');
  const card = page.getByTestId('godown-lot-duravit-lot');
  await expect(card).toContainText('Unit price: Not recorded');
  await expect(page.getByTestId('godown-lot-unknown-lot')).toContainText('Quantity not recorded');
  await expect(page.getByRole('button', { name: 'Transfer Uncounted basin to a customer' })).toBeDisabled();
  await page.getByTestId('godown-edit-duravit-lot').click();
  await page.getByTestId('godown-price-duravit-lot').fill('12345');
  await page.getByTestId('godown-image-url-duravit-lot').fill('https://example.test/cape-cod.jpg');
  await page.getByTestId('godown-save-duravit-lot').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ unit_price: 12345, image: 'https://example.test/cape-cod.jpg' });
  await expect(card).toContainText('12,345');
  await page.getByTestId('godown-edit-duravit-lot').click();
  await page.getByTestId('godown-price-duravit-lot').fill('');
  await page.getByTestId('godown-image-url-duravit-lot').fill('');
  await page.getByTestId('godown-save-duravit-lot').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ unit_price: null, image: null });
  await expect(card).toContainText('Unit price: Not recorded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical warehouse stock search finds rows beyond the initial card batch', async ({ page }) => {
  await mockSession(page, '/godown-stock', false);
  const lots = Array.from({ length: 1100 }, (_, i) => ({ id: `stock-${i}`,
    product_id: `product-${i}`, sku: `STOCK-${i}`, name: `Warehouse basin ${i}`,
    brand_name: 'Grohe', qty_received: 1, available_qty: 1, unit_price: 1000,
    stock_value: 1000, transferable_qty: 1, source_type: 'warehouse_import' }));
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots, brands: [], total_available_qty: 1100, total_stock_value: 1100000, unpriced_lot_count: 0,
  } }));
  await page.goto('/godown-stock');
  await expect(page.getByTestId('godown-lot-stock-0')).toBeVisible();
  await expect(page.getByTestId('godown-lot-stock-60')).toHaveCount(0);
  await page.getByTestId('godown-load-more').click();
  await expect(page.getByTestId('godown-lot-stock-60')).toBeAttached();
  await page.getByRole('textbox', { name: 'Search godown stock', exact: true }).fill('STOCK-1099');
  await expect(page.getByTestId('godown-lot-stock-1099')).toBeVisible();
  await expect(page.getByTestId('godown-lot-stock-0')).toHaveCount(0);
});

test('critical warehouse photo upload retains the selected file and saves price independently', async ({ page }) => {
  await mockSession(page, '/godown-stock', false);
  const lot = { id: 'photo-lot', product_id: 'product', sku: 'PHOTO', name: 'Photographed basin',
    brand_name: 'Duravit', qty_received: 1, available_qty: 1, transferable_qty: 1,
    unit_price: null, stock_value: null, image: null, price_variants: [] };
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots: [lot], brands: [], total_available_qty: 1, total_stock_value: 0, unpriced_lot_count: 1,
  } }));
  const writes: { path: string; body: unknown }[] = [];
  await page.route('**/api/godown-stock/photo-lot/image', route => {
    const body = route.request().postDataBuffer()!;
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    expect(route.request().headers()['content-type']).toContain('multipart/form-data');
    expect(body.toString()).toContain('filename="warehouse-photo.png"');
    writes.push({ path: 'image', body: body.length });
    return route.fulfill({ json: { ...lot, image: 'https://example.test/photo.png' } });
  });
  await page.route('**/api/godown-stock/photo-lot/details', route => {
    const body = route.request().postDataJSON();
    writes.push({ path: 'details', body });
    expect(body).toMatchObject({ unit_price: 2500 });
    expect(Object.hasOwn(body, 'image')).toBe(false);
    return route.fulfill({ json: { ...lot, ...body, image: 'https://example.test/photo.png', stock_value: 2500 } });
  });
  await page.goto('/godown-stock');
  await page.getByTestId('godown-edit-photo-lot').click();
  await page.getByTestId('godown-price-photo-lot').fill('2500');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('godown-upload-photo-lot').click();
  await (await chooser).setFiles({ name: 'warehouse-photo.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByText('warehouse-photo.png · ready to upload')).toBeVisible();
  await page.getByTestId('godown-save-photo-lot').click();
  await expect.poll(() => writes.map(write => write.path)).toEqual(['image', 'details']);
  await expect(page.getByTestId('godown-lot-photo-lot')).toContainText('2,500');
});
