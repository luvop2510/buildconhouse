import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function fixtureCatalog(page: Page, baseURL: string) {
  const blocked: string[] = [];
  const errors: string[] = [];
  const origin = new URL(baseURL).origin;
  await page.context().route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  page.on('pageerror', error => errors.push(error.message));
  await mockSession(page, '/catalog');
  const product = { id: 'fixture-product', name: 'Fixture basin', sku: 'FIXTURE-1', brand_id: 'fixture-brand', category_id: 'fixture-category', price: 1000, mrp: 1000, images: [], tags: [], stock: 1 };
  await page.route('**/api/brands**', route => route.fulfill({ json: [{ id: 'fixture-brand', name: 'Fixture Brand' }] }));
  await page.route('**/api/categories**', route => route.fulfill({ json: [{ id: 'fixture-category', name: 'Basins' }] }));
  await page.route('**/api/catalog/hierarchy**', route => route.fulfill({ json: { tree: [{ brand: { id: 'fixture-brand', name: 'Fixture Brand' }, product_count: 1, categories: [{ category: { id: 'fixture-category', name: 'Basins' }, subcategories: [] }] }] } }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 1, items: [{ family_key: 'fixture-family', family_name: 'Fixture basin', brand_id: 'fixture-brand', category_id: 'fixture-category', sample_product_id: product.id, min_price: 1000, max_price: 1000, product_count: 1, variants: [product] }] } }));
  await page.route('**/api/products?**', route => route.fulfill({ json: { total: 1, items: [product] } }));
  await page.route('**/api/products/fixture-product', route => route.fulfill({ json: product }));
  await page.route('**/api/products/fixture-product/alternates?**', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/purchases/items?**', route => route.fulfill({ json: { items: [] } }));
  return { blocked, errors };
}

test('catalog filter and clear controls support keyboard and readable names', async ({ page, baseURL }, info) => {
  const safety = await fixtureCatalog(page, baseURL!);
  await page.goto('/catalog');
  const filter = page.getByRole('button', { name: 'Catalog filters', exact: true });
  await expect(filter).toHaveAttribute('aria-expanded', 'false');
  await filter.focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('catalog-filters')).toBeVisible();
  await expect(page.getByTestId('catalog-filter-btn')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('catalog-filters')).not.toBeVisible();
  await expect(filter).toBeFocused();
  const search = page.getByRole('textbox', { name: 'Search catalog', exact: true });
  // Wait for the dismissed sheet to stop intercepting a user's next click.
  await search.click();
  await expect(search).toBeFocused();
  await search.fill('basin');
  await expect(search).toHaveValue('basin');
  const clear = page.getByRole('button', { name: 'Clear catalog search', exact: true });
  const target = await clear.boundingBox();
  expect(target!.width).toBeGreaterThanOrEqual(44);
  expect(target!.height).toBeGreaterThanOrEqual(44);
  await clear.focus();
  await page.keyboard.press('Space');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(clear).not.toBeVisible();
  const brand = page.getByTestId('brand-pill-all');
  if (await brand.isVisible()) expect((await brand.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(safety.blocked).toEqual([]);
  expect(safety.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('catalog-populated.png') });
});

test('catalog families and variants expose named keyboard destinations', async ({ page, baseURL }) => {
  const safety = await fixtureCatalog(page, baseURL!);
  await page.goto('/catalog');
  const family = page.getByTestId('family-fixture-family');
  await expect(family).toHaveAttribute('role', 'button');
  await expect(family).toHaveAccessibleName('View Fixture Brand Fixture basin');
  await family.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/catalog\/fixture-product$/);
  await expect(page.getByText('Fixture basin', { exact: true }).first()).toBeVisible();
  await page.goto('/catalog');
  await page.getByRole('tab', { name: 'Variants', exact: true }).click();
  const variant = page.getByTestId('product-fixture-product');
  await expect(variant).toHaveAttribute('role', 'button');
  await expect(variant).toHaveAccessibleName('View Fixture Brand Fixture basin, FIXTURE-1');
  await variant.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/catalog\/fixture-product$/);
  await expect(page.getByText('Fixture basin', { exact: true }).first()).toBeVisible();
  expect(safety.blocked).toEqual([]);
  expect(safety.errors).toEqual([]);
});

for (const failure of ['references', 'hierarchy'] as const) {
  test(`catalog preserves products and search while retrying failed ${failure}`, async ({ page, baseURL }) => {
    const safety = await fixtureCatalog(page, baseURL!);
    let fail = true;
    let productReads = 0;
    const mutations: string[] = [];
    page.on('request', request => {
      if (!request.url().includes('/api/')) return;
      if (request.method() !== 'GET') mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
      if (new URL(request.url()).pathname === '/api/products/families') productReads += 1;
    });
    if (failure === 'references') {
      await page.route('**/api/brands**', route => route.fulfill(fail ? { status: 503, json: { detail: 'Fixture brands unavailable' } } : { json: [{ id: 'fixture-brand', name: 'Fixture Brand' }] }));
      await page.route('**/api/categories**', route => route.fulfill(fail ? { status: 503, json: { detail: 'Fixture categories unavailable' } } : { json: [{ id: 'fixture-category', name: 'Basins' }] }));
    } else {
      await page.route('**/api/catalog/hierarchy**', route => route.fulfill(fail ? { status: 503, json: { detail: 'Fixture hierarchy unavailable' } } : { json: { tree: [{ brand: { id: 'fixture-brand', name: 'Fixture Brand' }, product_count: 1, categories: [{ category: { id: 'fixture-category', name: 'Basins' }, subcategories: [{ name: 'Fixture subcategory', series: [{ name: 'Fixture series' }] }] }] }] } }));
    }
    await page.goto('/catalog');
    const family = page.getByTestId('family-fixture-family');
    await expect(family).toBeVisible();
    const error = failure === 'references' ? 'Catalog brands and categories could not be loaded.' : 'Catalog subcategories, series and brand counts could not be loaded.';
    await expect(page.getByRole('alert')).toContainText(error);
    if (failure === 'hierarchy' && await page.getByTestId('brand-pill-all').isVisible()) {
      await expect(page.getByTestId('brand-pill-all')).toHaveAccessibleName('All brands');
    }
    const search = page.getByRole('textbox', { name: 'Search catalog', exact: true });
    const searchResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/products/families' && new URL(response.url()).searchParams.get('q') === 'basin');
    await search.fill('basin');
    await searchResponse;
    await expect(page.getByText('Loading…', { exact: true })).not.toBeVisible();
    await expect(family).toBeVisible();
    const readsBefore = productReads;
    fail = false;
    await page.getByRole('button', { name: 'Retry catalog filters', exact: true }).click();
    await expect(page.getByRole('alert')).not.toBeVisible();
    await expect(search).toHaveValue('basin');
    await expect(family).toBeVisible();
    expect(productReads).toBe(readsBefore);
    await page.getByRole('button', { name: 'Catalog filters', exact: true }).click();
    const sheet = page.getByTestId('catalog-filters');
    await expect(sheet.getByRole('button', { name: 'Fixture Brand', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Basins', exact: true })).toBeVisible();
    if (failure === 'hierarchy') {
      await expect(sheet.getByRole('button', { name: 'Fixture subcategory', exact: true })).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Fixture series', exact: true })).toBeVisible();
    }
    expect(mutations).toEqual([]);
    expect(safety.blocked).toEqual([]);
    expect(safety.errors).toEqual([]);
  });
}

test('catalog distinguishes unavailable product counts from a successful empty search', async ({ page, baseURL }) => {
  const safety = await fixtureCatalog(page, baseURL!);
  let failed = true;
  await page.route('**/api/products/families?**', route => failed
    ? route.fulfill({ status: 503, json: { detail: 'Fixture products unavailable' } })
    : route.fulfill({ json: { total: 0, items: [] } }));
  await page.goto('/catalog');
  await expect(page.getByText("Couldn't load the catalog", { exact: true })).toBeVisible();
  await expect(page.getByText('Catalog data is unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('0 families', { exact: true })).toHaveCount(0);
  const searched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/products/families'
    && new URL(response.url()).searchParams.get('q') === 'missing');
  await page.getByRole('textbox', { name: 'Search catalog', exact: true }).fill('missing');
  await searched;
  await expect(page.getByText("Couldn't load the catalog", { exact: true })).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Nothing matches', { exact: true })).toBeVisible();
  await expect(page.getByText('0 families', { exact: true })).toBeVisible();
  expect(safety.blocked).toEqual([]);
  expect(safety.errors).toEqual([]);
});
