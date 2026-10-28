import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function builderFixture(page: Page) {
  await mockSession(page, '/quotations/new', false);
  const requests: URLSearchParams[] = [];
  const customProducts: any[] = [];
  let document: any = { id: 'q-mobile', number: 'Q-MOBILE', customer_id: 'buyer', customer_name: 'Mobile buyer', status: 'draft', floor_id: 'first-floor', rooms: ['Master Bath'], items: [], updated_at: '2026-10-13T12:00:00Z' };
  await page.route('**/api/customers**', route => route.fulfill({ json: [{ id: 'buyer', name: 'Mobile buyer' }] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [{ id: 'grohe', name: 'GROHE', product_count: 4 }, { id: 'vitra', name: 'Vitra', product_count: 4 }] }));
  await page.route('**/api/categories**', route => route.fulfill({ json: [{ id: 'basins', name: 'Basins', product_count: 4 }, { id: 'showers', name: 'Showers', product_count: 4 }] }));
  await page.route('**/api/catalog/facets**', route => route.fulfill({ json: { sizes: [{ value: 'Standard' }, { value: 'Large' }] } }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => {
    requests.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { total: 12, items: Array.from({ length: 12 }, (_, index) => ({
      family_key: `basin-${index}`, family_name: `Basin ${index + 1}`, brand_id: 'grohe', category_id: 'basins', min_price: 1600,
      variants: [{ id: `basin-${index}`, sku: `B-${index}`, name: `Basin ${index + 1}`, price: 1600, mrp: 1600, stock: 2 }],
    })) } });
  });
  await page.route('**/api/products/custom', route => {
    customProducts.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: `custom-saved-${customProducts.length}`, images: [], variants: [], ...customProducts.at(-1), sku: `CUSTOM-SAVED-${customProducts.length}` } });
  });
  await page.route(/\/api\/quotations\/q-mobile(?:\?.*)?$/, route => {
    if (route.request().method() === 'PATCH') document = { ...document, ...route.request().postDataJSON() };
    return route.fulfill({ json: document });
  });
  await page.goto('/quotations/new?quotationId=q-mobile');
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  await expect(page.getByTestId('product-card-B-0').first()).toBeVisible();
  return { requests, customProducts, saved: () => document };
}

test('critical mobile quotation product focus preserves filtering and exposes complete catalog actions', async ({ page }, info) => {
  test.skip(page.viewportSize()!.width > 1024, 'Compact quotation workspace');
  const fixture = await builderFixture(page);
  const exit = page.getByTestId('expand-quotation-workspace');
  if (page.viewportSize()!.width < 768) {
    await expect(exit).toBeVisible();
    await expect(page.getByTestId('quotation-details-toggle')).toHaveCount(0);
    await exit.click();
  }
  const focus = page.getByTestId('collapse-quotation-workspace');
  test.skip(!(await focus.isVisible()), 'Two-pane tablet already has inline product browsing');
  const before = await page.getByTestId('product-card-B-0').boundingBox();
  await focus.click();
  const back = page.getByTestId('builder-back');
  await expect(back).toBeAttached();
  await expect(back).toBeHidden();
  await expect(page.getByTestId('quotation-details-toggle')).toHaveCount(0);
  const focused = await page.getByTestId('product-card-B-0').boundingBox();
  expect(focused!.y).toBeLessThan(before!.y);
  await page.screenshot({ path: info.outputPath('mobile-products-full-screen.png') });
  await page.getByTestId('explorer-filter-toggle').click();
  const filters = page.getByRole('dialog', { name: 'Filters and sort', exact: true });
  await expect(filters).toBeVisible();
  await filters.getByTestId('mobile-brand-GROHE').click();
  await filters.getByTestId('mobile-brand-Vitra').click();
  await filters.getByTestId('mobile-category-Basins').click();
  await filters.getByRole('button', { name: 'Large', exact: true }).click();
  await filters.getByTestId('sort-price_asc').click();
  await page.screenshot({ path: info.outputPath('mobile-product-filters.png') });
  await filters.getByTestId('explorer-filter-done').click();
  await expect(filters).not.toBeVisible();
  await expect.poll(() => fixture.requests.some(params => params.getAll('brand_ids').join() === 'vitra' && params.getAll('category_ids').join() === 'basins' && params.getAll('sizes').join() === 'Large')).toBe(true);
  await page.getByTestId('add-B-0').click();
  await expect(page.getByText('1 in this room', { exact: true })).toBeVisible();
  await page.getByTestId('expand-quotation-workspace').click();
  await expect(back).toBeVisible();
  await page.getByTestId('explorer-filter-toggle').click();
  await expect(filters.getByTestId('mobile-brand-Vitra')).toHaveAttribute('aria-pressed', 'true');
  await expect(filters.getByTestId('sort-price_asc')).toHaveAttribute('aria-pressed', 'true');
  await filters.getByTestId('explorer-filter-reset').click();
  await expect(filters.getByTestId('mobile-brand-all')).toHaveAttribute('aria-pressed', 'true');
  await filters.getByTestId('explorer-filter-done').click();
  await page.getByTestId('mobile-review-quotation').click();
  await expect(page.locator('[data-testid^="qty-basin-0-"]')).toBeVisible();
  await expect(page.getByTestId('quote-notes-input')).toHaveCount(0);
  await expect(page.getByTestId('assist-line-notes')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('mobile-quotation-review.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical mobile quotation adds custom products from full-screen picker and saves or keeps them inline', async ({ page }, info) => {
  test.skip(page.viewportSize()!.width > 1024, 'Compact quotation workspace');
  const fixture = await builderFixture(page);
  await page.getByTestId('mobile-add-first').click();
  const picker = page.getByRole('dialog', { name: 'Add products', exact: true });
  await expect(picker).toBeVisible();
  await picker.getByTestId('explorer-custom-product').click();
  const custom = page.getByRole('dialog', { name: 'Custom product', exact: true });
  await expect(custom).toBeVisible();
  await expect(picker).not.toBeVisible();
  await custom.getByTestId('cp-name').fill('Measured custom shelf');
  await custom.getByTestId('cp-price').fill('450');
  await custom.getByLabel('Custom product description').fill('Cut to customer dimensions');
  for (const invalidMrp of ['-1', 'Infinity']) {
    await custom.getByLabel('Custom product MRP').fill(invalidMrp);
    await custom.getByTestId('cp-commit').click();
    await expect(custom).toBeVisible();
    await expect(page.getByText('Enter a valid MRP (zero or more)', { exact: true })).toBeVisible();
    expect(fixture.customProducts).toHaveLength(0);
    expect(fixture.saved().items).toHaveLength(0);
  }
  await custom.getByLabel('Custom product MRP').fill('');
  await custom.getByTestId('cp-save').click();
  await page.screenshot({ path: info.outputPath('mobile-custom-product.png') });
  await custom.getByTestId('cp-commit').click();
  await expect(custom).not.toBeVisible();
  expect(fixture.customProducts).toEqual([expect.objectContaining({ name: 'Measured custom shelf', keep_in_catalog: false })]);
  await expect.poll(() => fixture.saved().items.length).toBe(1);
  expect(fixture.saved().items[0]).toMatchObject({ name: 'Measured custom shelf', unit_price: 450, description: 'Cut to customer dimensions' });
  // The same action is available without first opening the picker.
  await page.getByTestId('explorer-custom-product').filter({ visible: true }).click();
  await custom.getByTestId('cp-name').fill('Reusable custom basin');
  await custom.getByTestId('cp-price').fill('900');
  await custom.getByLabel('Custom product MRP').fill('0');
  await custom.getByTestId('cp-commit').click();
  await expect(custom).not.toBeVisible();
  expect(fixture.customProducts).toEqual([
    expect.objectContaining({ name: 'Measured custom shelf', keep_in_catalog: false }),
    expect.objectContaining({ name: 'Reusable custom basin', price: 900, mrp: 0, is_custom: true, keep_in_catalog: true }),
  ]);
  // The two-pane tablet already displays the quotation beside the catalog.
  const review = page.getByRole('button', { name: 'Review quotation', exact: true });
  await expect(review.or(page.getByTestId('receipt-list')).filter({ visible: true }).first()).toBeVisible();
  if (await review.isVisible()) await review.click();
  await expect(page.getByTestId('receipt-list')).toBeVisible();
  await expect(page.getByText('Measured custom shelf', { exact: true })).toBeVisible();
  await expect(page.getByText('Reusable custom basin', { exact: true })).toBeVisible();
  await expect.poll(() => fixture.saved().items.length).toBe(2);
  await page.reload();
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  await expect(review.or(page.getByTestId('receipt-list')).filter({ visible: true }).first()).toBeVisible();
  if (await review.isVisible()) await review.click();
  await expect(page.getByTestId('receipt-list')).toBeVisible();
  await expect(page.getByText('Measured custom shelf', { exact: true })).toBeVisible();
  await expect(page.getByText('Reusable custom basin', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical quotation search hides stale cards and recovers from an empty filtered result', async ({ page }) => {
  await builderFixture(page);
  let releaseSearch!: () => void;
  const heldSearch = new Promise<void>(resolve => { releaseSearch = resolve; });
  let requested = false;
  await page.route('**/api/products/families?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'No matching basin') return route.fallback();
    requested = true;
    await heldSearch;
    return route.fulfill({ json: { total: 0, items: [] } });
  });
  const search = page.getByTestId('explorer-search').filter({ visible: true });
  await search.fill('No matching basin');
  await expect.poll(() => requested).toBe(true);
  // Previous results must never remain addable under the new search term.
  await expect(page.getByTestId('add-B-0').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByTestId('explorer-products-loading').filter({ visible: true })).toBeVisible();
  releaseSearch();
  await expect(page.getByText('No products match', { exact: true })).toBeVisible();
  await page.getByTestId('explorer-clear-filters').click();
  await expect(search).toHaveValue('');
  await expect(page.getByTestId('add-B-0').filter({ visible: true })).toBeVisible();
});

test('critical mobile quotation chooses a room directly while browsing and retains the selection through review', async ({ page }, info) => {
  test.skip(page.viewportSize()!.width >= 768, 'Single-pane phone workspace');
  const fixture = await builderFixture(page);
  const search = page.getByTestId('explorer-search').filter({ visible: true });
  await search.fill('Basin');
  await expect(page.getByTestId('browse-room-toggle')).toHaveCount(0);
  await search.blur();
  await expect(page.getByTestId('browse-room-toggle')).toBeVisible();
  await page.getByTestId('browse-room-toggle').click();
  await page.getByTestId('add-room-btn').filter({ visible: true }).click();
  await page.getByTestId('room-input').fill('Guest Bath');
  await page.getByTestId('submit-room').click();
  await expect(page.getByTestId('browse-room-toggle')).toContainText('Guest Bath');
  await page.getByTestId('add-B-0').click();
  await expect(page.getByText('1 in this room', { exact: true })).toBeVisible();
  await page.getByTestId('browse-room-toggle').click();
  await page.screenshot({ path: info.outputPath('sanitary-browse-room-switch.png') });
  await page.getByTestId('room-Master Bath').filter({ visible: true }).click();
  await expect(page.getByText('1 in this room', { exact: true })).toHaveCount(0);
  await page.getByTestId('add-B-1').click();
  await page.getByTestId('mobile-review-quotation').click();
  await expect.poll(() => fixture.saved().items.length).toBe(2);
  expect(fixture.saved().items).toEqual(expect.arrayContaining([
    expect.objectContaining({ product_id: 'basin-0', room: 'Guest Bath' }),
    expect.objectContaining({ product_id: 'basin-1', room: 'Master Bath' }),
  ]));
  await page.screenshot({ path: info.outputPath('sanitary-room-selection-review.png') });
});

test('critical quotation search retries a failed query without losing its draft or search', async ({ page }) => {
  const fixture = await builderFixture(page);
  await page.getByTestId('add-B-0').filter({ visible: true }).click();
  let attempts = 0;
  await page.route('**/api/products/families?**', route => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'Recovery basin') return route.fallback();
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { detail: 'Catalog temporarily unavailable' } })
      : route.fulfill({ json: { total: 1, items: [{ family_key: 'recovered', family_name: 'Recovery basin', brand_id: 'grohe', category_id: 'basins', min_price: 1800,
        variants: [{ id: 'recovered', sku: 'RECOVERED', name: 'Recovery basin', price: 1800, mrp: 1800, stock: 2 }] }] } });
  });
  const search = page.getByTestId('explorer-search').filter({ visible: true });
  await search.fill('Recovery basin');
  await expect(page.getByText('Products unavailable', { exact: true })).toBeVisible();
  await expect(page.getByTestId('add-B-0').filter({ visible: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(search).toHaveValue('Recovery basin');
  await expect(page.getByTestId('add-RECOVERED').filter({ visible: true })).toBeVisible();
  await expect.poll(() => fixture.saved().items.length).toBe(1);
  expect(fixture.saved().items[0]).toMatchObject({ product_id: 'basin-0', room: 'Master Bath' });
});

test('critical product add feedback does not block a deliberate second quantity addition', async ({ page }) => {
  await builderFixture(page);
  const add = page.getByTestId('add-B-0').first();
  // Ignore a duplicate tap, while keeping the feedback animation separate
  // from the next deliberate quantity change.
  await add.dblclick();
  await expect(page.getByText('1 in this room', { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(250);
  await add.click();
  await expect(page.getByText('2 in this room', { exact: true }).first()).toBeVisible();
});


test('critical quotation room actions preserve the room name in a narrow desktop panel', async ({ page }) => {
  await builderFixture(page);
  await page.getByTestId('add-B-0').first().click();
  const review = page.getByTestId('mobile-review-quotation');
  if (await review.isVisible()) await review.click();
  const room = page.getByTestId('room-name-Master Bath');
  await expect(room).toBeVisible();
  expect((await room.boundingBox())!.width).toBeGreaterThan(140);
  for (const action of ['room-rename-Master Bath', 'room-discount-Master Bath', 'room-dup-Master Bath', 'room-delete-Master Bath']) {
    const box = await page.getByTestId(action).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});
