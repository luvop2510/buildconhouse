import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical stock photos distinguish missing, loading and failed images and recover after replacement', async ({ page }, info) => {
  await mockSession(page, '/godown-stock', false);
  let release!: () => void;
  const heldPhoto = new Promise<void>(resolve => { release = resolve; });
  let lot = { id: 'photo-state', product_id: 'godown:photo-state', sku: 'PHOTO-1', name: 'Photo review basin',
    qty_received: 2, available_qty: 2, transferable_qty: 2, unit_price: 100, stock_value: 200,
    image: 'https://images.test/held-photo.png' as string | null };
  await page.route('https://images.test/held-photo.png', async route => {
    await heldPhoto;
    await route.fulfill({ status: 404 });
  });
  await page.route('https://images.test/replacement.png', route => route.fulfill({ status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64') }));
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots: [lot, { ...lot, id: 'no-photo', name: 'Unphotographed basin', image: null }],
    brands: [], total_available_qty: 4, total_stock_value: 400, unpriced_lot_count: 0,
  } }));
  await page.route('**/api/godown-stock/photo-state/details', route => {
    lot = { ...lot, ...route.request().postDataJSON() };
    return route.fulfill({ json: lot });
  });
  await page.goto('/godown-stock');
  const card = page.getByTestId('godown-lot-photo-state');
  await expect(card.getByText('Loading photo', { exact: true })).toBeVisible();
  await expect(page.getByTestId('godown-lot-no-photo').getByText('Photo needed', { exact: true })).toBeVisible();
  release();
  await expect(card.getByText('Photo unavailable', { exact: true })).toBeVisible();
  await page.getByTestId('godown-edit-photo-state').click();
  await page.getByTestId('godown-image-url-photo-state').fill('https://images.test/replacement.png');
  await page.getByTestId('godown-save-photo-state').click();
  await expect(card.getByText('Photo unavailable', { exact: true })).toHaveCount(0);
  await expect(card.getByText('Loading photo', { exact: true })).toHaveCount(0);
  await expect(card.getByLabel('Photo review basin product image')).toBeVisible();
  await page.screenshot({ path: info.outputPath('stock-photo-states.png'), fullPage: true });
});

test('critical direct stock intake retries the same command and starts a new key after confirmed success', async ({ page }) => {
  await mockSession(page, '/godown-stock', false);
  const lot = { id: 'intake-lot', product_id: 'godown:intake-lot', sku: 'VALVE-1', name: 'Intake valve',
    qty_received: 3, available_qty: 3, transferable_qty: 3, unit_price: 125, stock_value: 375 };
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots: [], brands: [], total_available_qty: 0, total_stock_value: 0, unpriced_lot_count: 0,
  } }));
  await page.route('**/api/godown-stock/intake-lot/po-final-matches', route => route.fulfill({ json: { matches: [] } }));
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/godown-stock/direct-intakes', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    commands.push(route.request().postDataJSON());
    // Simulate the server completing intake while its response cannot be used.
    return route.fulfill(commands.length === 1
      ? { status: 504, json: { detail: 'Response lost. Retry to confirm this intake.' } }
      : { json: { ...lot, idempotent: commands.length === 2 } });
  });
  await page.goto('/godown-stock');
  const fill = async () => {
    await page.getByRole('button', { name: 'Add product to godown', exact: true }).click();
    await page.getByRole('tab', { name: 'Product not in catalog', exact: true }).click();
    await page.getByRole('textbox', { name: 'SKU code', exact: true }).fill('VALVE-1');
    await page.getByRole('textbox', { name: 'Product name', exact: true }).fill('Intake valve');
    await page.getByRole('textbox', { name: 'Unit price', exact: true }).fill('125');
    await page.getByRole('textbox', { name: 'Quantity to add', exact: true }).fill('3');
  };
  await fill();
  const submit = page.getByRole('button', { name: 'Add to godown stock', exact: true });
  await submit.click();
  await expect.poll(() => commands.length).toBe(1);
  await expect(submit).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Quantity to add', exact: true })).toHaveValue('3');
  await submit.click();
  await expect(submit).toHaveCount(0);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  await fill();
  await submit.click();
  await expect(submit).toHaveCount(0);
  expect(commands).toHaveLength(3);
  expect(commands[2].idempotency_key).not.toBe(commands[0].idempotency_key);
});

test('critical stock refresh preserves another lot draft after transfer and offers recovery on read failure', async ({ page }, info) => {
  await mockSession(page, '/godown-stock', false);
  const stock = { id: 'transfer-lot', product_id: 'product', sku: 'TRANSFER', name: 'Transfer basin',
    brand_name: 'Duravit', qty_received: 2, available_qty: 2, transferable_qty: 2,
    unit_price: 1000, stock_value: 2000, image: null, price_variants: [] };
  const draftLot = { ...stock, id: 'draft-lot', sku: 'DRAFT', name: 'Draft basin' };
  let reads = 0;
  let transfers = 0;
  let releaseRefresh!: () => void;
  const pendingRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.route('**/api/godown-stock?**', async route => {
    reads += 1;
    if (reads === 2) {
      await pendingRefresh;
      await route.fulfill({ status: 503, json: { detail: 'Temporary stock read failure' } });
      return;
    }
    await route.fulfill({ json: { lots: [stock, draftLot], brands: [], total_available_qty: 4,
      total_stock_value: 4000, unpriced_lot_count: 0 } });
  });
  await page.route('**/api/customers', route => route.fulfill({ json: [{ id: 'recipient', name: 'Stock recipient' }] }));
  await page.route('**/api/godown-stock/transfer-lot/po-final-matches', route => route.fulfill({ json: { matches: [] } }));
  await page.route('**/api/godown-stock/transfer-lot/customer-transfers', route => {
    transfers += 1;
    return route.fulfill({ json: { id: 'transfer-receipt', recipient_customer_name: 'Stock recipient' } });
  });
  await page.goto('/godown-stock');
  await page.getByTestId('godown-edit-draft-lot').click();
  const draft = page.getByTestId('godown-price-draft-lot');
  await draft.fill('2345');
  // Keep the exact DOM instance as evidence that refresh did not remount it.
  await draft.evaluate(input => { (window as any).__stockDraftInput = input; });
  await page.getByRole('button', { name: 'Transfer Transfer basin to a customer', exact: true }).click();
  await page.getByTestId('godown-recipient-recipient').click();
  await page.getByTestId('godown-customer-transfer-submit').click();
  await expect(page.getByTestId('godown-refresh-status')).toContainText('Refreshing stock');
  await expect(draft).toHaveValue('2345');
  expect(await draft.evaluate(input => (window as any).__stockDraftInput === input)).toBe(true);
  releaseRefresh();
  await expect(page.getByTestId('godown-refresh-status')).toContainText('Displayed quantities may be out of date');
  await expect(page.getByTestId('godown-customer-transfer-submit')).toHaveCount(0);
  await expect(draft).toHaveValue('2345');
  await page.getByTestId('godown-refresh-status').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('stock-refresh-draft-recovery.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry stock refresh', exact: true }).click();
  await expect(page.getByTestId('godown-refresh-status')).toHaveCount(0);
  await expect(draft).toHaveValue('2345');
  expect(await draft.evaluate(input => (window as any).__stockDraftInput === input)).toBe(true);
  expect(transfers).toBe(1);
});

test('critical warehouse stock edits price and image, keeps unknown quantities visible and fits each viewport', async ({ page }, info) => {
  await mockSession(page, '/godown-stock', false);
  let lot = { id: 'duravit-lot', product_id: 'duravit-product', sku: '2328480000',
    name: 'Cape Cod washbowl', brand_name: 'Duravit', qty_received: 2, available_qty: 2,
    transferable_qty: 2, unit_price: null as number | null, stock_value: null as number | null,
    image: 'https://images.test/catalog.jpg' as string | null, source_type: 'warehouse_import', price_variants: [],
  };
  const unknown = { ...lot, id: 'unknown-lot', name: 'Uncounted basin', sku: 'UNCOUNTED',
    qty_received: 0, available_qty: 0, transferable_qty: 0, quantity_missing: true };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots: [lot, unknown], brands: [], total_available_qty: 2,
    total_stock_value: lot.stock_value || 0, unpriced_lot_count: lot.unit_price === null ? 1 : 0,
  } }));
  await page.route('https://images.test/catalog.jpg', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64') }));
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
  await expect(card.getByLabel('Cape Cod washbowl product image')).toBeVisible();
  await expect(page.getByTestId('godown-lot-unknown-lot')).toContainText('Quantity not recorded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (page.viewportSize()!.width < 768) {
    const actions = card.getByTestId('godown-phone-primary-actions');
    await expect(actions).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Transfer Cape Cod washbowl to a customer' })).toBeVisible();
    await expect(actions.getByRole('button', { name: /Cape Cod washbowl.*quotation/ })).toBeVisible();
    const buttonBounds = await actions.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    expect(buttonBounds).toHaveLength(2);
    expect(buttonBounds.every(bounds => bounds.bottom - bounds.top >= 44)).toBe(true);
    expect(buttonBounds[1].left).toBeGreaterThanOrEqual(buttonBounds[0].right);
  }
  await page.screenshot({ path: info.outputPath('godown-stock-responsive.png'), fullPage: true });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('godown-stock-lot-actions.png') });
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

test('critical warehouse-only details and unpriced quotation actions always offer a next step', async ({ page }, info) => {
  await mockSession(page, '/godown-stock', false);
  let lot = { id: 'warehouse-only', product_id: 'godown:warehouse-only', sku: 'LOCAL-1', name: 'Warehouse mixer',
    brand_name: 'Local stock', qty_received: 2, available_qty: 2, transferable_qty: 2,
    unit_price: null as number | null, stock_value: null as number | null, image: null, price_variants: [], source_type: 'warehouse_import' };
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: {
    lots: [lot], brands: [], total_available_qty: 2, total_stock_value: lot.stock_value || 0, unpriced_lot_count: lot.unit_price === null ? 1 : 0,
  } }));
  await page.route('**/api/godown-stock/warehouse-only/details', route => {
    lot = { ...lot, ...route.request().postDataJSON(), stock_value: 4000 };
    return route.fulfill({ json: lot });
  });
  await page.route('**/api/godown-stock/warehouse-only', route => route.fulfill({ json: lot }));
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.goto('/godown-stock');
  const card = page.getByTestId('godown-lot-warehouse-only');
  await card.getByRole('button', { name: 'View stock details for Warehouse mixer' }).click();
  await expect(card).toContainText('Imported from the godown stock workbook');
  await card.getByRole('button', { name: 'Set price and add Warehouse mixer to a new quotation' }).click();
  await expect(card.getByTestId('godown-price-warehouse-only')).toBeVisible();
  await expect(card).toContainText('Enter a unit price to add this stock to a quotation.');
  await card.getByTestId('godown-price-warehouse-only').fill('2000');
  await page.screenshot({ path: info.outputPath('godown-price-first-editor.png') });
  await card.getByTestId('godown-save-warehouse-only').click();
  await expect(page).toHaveURL(/\/quotations\/new\?godownStockId=warehouse-only$/);
  await expect(page.getByText('Warehouse mixer added from godown stock — select a customer to reserve it', { exact: true })).toBeVisible();
  const exitFullscreen = page.getByTestId("expand-quotation-workspace");
  if (await exitFullscreen.isVisible()) await exitFullscreen.click();
  const review = page.getByTestId('mobile-review-quotation');
  if (await review.isVisible()) await review.click();
  await expect(page.locator('[data-testid^="qty-godown-warehouse-only-"]')).toHaveValue('1');
  await page.screenshot({ path: info.outputPath('godown-seeded-quotation.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical a godown quotation deep link rejects an unrecorded price instead of creating a free line', async ({ page }) => {
  await mockSession(page, '/quotations/new', false);
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/godown-stock/unpriced', route => route.fulfill({ json: {
    id: 'unpriced', product_id: 'godown:unpriced', name: 'Unpriced warehouse mixer', sku: 'UNPRICED',
    available_qty: 2, transferable_qty: 2, unit_price: null,
  } }));
  await page.goto('/quotations/new?godownStockId=unpriced');
  await expect(page.getByText('Record a unit price in Godown stock before adding this lot to a quotation.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid^="qty-godown-unpriced-"]')).toHaveCount(0);
});


test('critical restock an empty product and retry the same stock movement after a lost response', async ({ page }, info) => {
  await mockSession(page, '/godown-stock', false);
  let lot: any = { id: 'empty-lot', product_id: 'catalog-id', sku: 'EMPTY-1', name: 'Restock basin', qty_received: 2, available_qty: 0, unit_price: 100, updated_at: 'v1', stock_movements: [] };
  await page.route('**/api/godown-stock?**', route => route.fulfill({ json: { lots: [lot], brands: [], total_available_qty: lot.available_qty, total_stock_value: lot.available_qty * 100, unpriced_lot_count: 0 } }));
  const commands: any[] = [];
  await page.route('**/api/godown-stock/empty-lot/movements', route => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) {
      lot = { ...lot, available_qty: 4, qty_received: 6, updated_at: 'v2', stock_movements: [{ id: 'movement', kind: 'receipt', qty: 4, occurred_on: '2026-10-28', actor_name: 'QA user', reason: 'Supplier delivery' }] };
      return route.fulfill({ status: 504, json: { detail: 'Response lost after commit. Retry this movement.' } });
    }
    expect(commands[1]).toEqual(commands[0]);
    return route.fulfill({ json: { ...lot, idempotent: true } });
  });
  await page.goto('/godown-stock');
  await page.getByTestId('godown-movement-empty-lot').click();
  await page.getByTestId('godown-movement-qty-empty-lot').fill('4');
  await page.getByTestId('godown-movement-date-empty-lot').fill('2026-10-28');
  await page.getByTestId('godown-movement-reason-empty-lot').fill('Supplier delivery');
  await page.getByTestId('godown-movement-save-empty-lot').click();
  await expect(page.getByRole('button', { name: 'Retry same movement', exact: true })).toBeVisible();
  await expect(page.getByTestId('godown-movement-qty-empty-lot')).toHaveJSProperty('readOnly', true);
  await page.getByTestId('godown-movement-save-empty-lot').click();
  await expect(page.getByTestId('godown-movement-save-empty-lot')).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(lot.available_qty).toBe(4);
  await page.screenshot({ path: info.outputPath('restocked-product.png'), fullPage: true });
});
