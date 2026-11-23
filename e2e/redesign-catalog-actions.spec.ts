import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('empty category can be found and deleted from the catalog', async ({ page }) => {
  await mockSession(page, '/catalog', false, { floorId: 'first-floor' });
  let deleted = false;
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/categories**', route => {
    if (route.request().method() === 'DELETE') {
      expect(new URL(route.request().url()).pathname).toBe('/api/categories/custom-category');
      deleted = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: deleted ? [] : [{ id: 'custom-category', name: 'Custom category' }] });
  });
  await page.route('**/api/catalog/facets**', route => route.fulfill({ json: {} }));
  await page.route('**/api/catalog/hierarchy**', route => route.fulfill({ json: { tree: [] } }));
  await page.route('**/api/products/families**', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.goto('/catalog');
  await page.getByTestId('open-delete-category').click();
  await page.getByTestId('manage-delete-category-custom-category').click();
  expect(deleted).toBe(false);
  await page.getByTestId('confirm-delete-category-confirm').click();
  await expect.poll(() => deleted).toBe(true);
  await expect(page.getByTestId('manage-delete-category-custom-category')).toHaveCount(0);
});

for (const floor of ['first-floor', 'ground-floor']) {
  test(`critical custom catalog product is addable on ${floor}`, async ({ page }) => {
    await mockSession(page, '/catalog', false, { floorId: floor });
    await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
    await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
    await page.route('**/api/catalog/facets**', route => route.fulfill({ json: {} }));
    await page.route('**/api/catalog/hierarchy**', route => route.fulfill({ json: { tree: [] } }));
    let saved = false;
    const attempts: string[] = [];
    await page.route('**/api/products/families**', route => route.fulfill({
      json: saved && new URL(route.request().url()).searchParams.get('q') === 'CUSTOM-1' ? { total: 1, items: [{
      family_key: null, family_name: 'Synthetic product', brand_id: 'brand', category_id: 'category',
      sample_product_id: 'new', floor_id: floor, min_price: 120, max_price: 120,
      product_count: 1, variants: [{ id: 'new', sku: 'CUSTOM-1', price: 120, mrp: 120 }],
      }] } : { items: [], total: 0 },
    }));
    await page.route('**/api/products/catalog-custom', route => {
      const body = route.request().postDataJSON();
      expect(body.name).toBe('Synthetic product');
      expect(body.price).toBe(120);
      expect(route.request().headers()['x-floor-id']).toBe(floor);
      attempts.push(body.request_id);
      if (attempts.length === 1) return route.fulfill({ status: 503, json: { detail: 'Product save is temporarily unavailable' } });
      saved = true;
      return route.fulfill({ json: { id: 'new', sku: 'CUSTOM-1', brand_id: 'brand', category_id: 'category', floor_id: floor, active: true } });
    });
    await page.goto('/catalog');
    await page.getByTestId('catalog-search').fill('Previously searched SKU');
    await page.getByTestId('add-catalog-product').click();
    await page.getByTestId('custom-catalog-name').fill('Synthetic product');
    await page.getByTestId('custom-catalog-price').fill('120');
    await page.getByTestId('save-catalog-custom-product').click();
    await expect(page.getByRole('alert')).toHaveText('Product save is temporarily unavailable');
    await expect(page.getByTestId('custom-catalog-name')).toHaveValue('Synthetic product');
    await expect(page.getByTestId('custom-catalog-price')).toHaveValue('120');
    await expect(page.getByTestId('family-new')).toHaveCount(0);
    await page.getByTestId('save-catalog-custom-product').click();
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[0]).toBe(attempts[1]);
    await expect(page.getByTestId('save-catalog-custom-product')).toHaveCount(0);
    await expect(page.getByTestId('catalog-search')).toHaveValue('CUSTOM-1');
    await expect(page.getByTestId('family-new')).toBeVisible();
  });
}

test('catalog deletion shows progress and permits retry after failure', async ({ page }) => {
  await mockSession(page, '/catalog/product-one', false, { floorId: 'first-floor' });
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  let attempts = 0;
  let release: (() => void) | undefined;
  await page.route('**/api/products/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/products/product-one' && route.request().method() === 'DELETE') {
      attempts++;
      if (attempts === 1) {
        await new Promise<void>(resolve => { release = resolve; });
        return route.fulfill({ status: 503, json: { detail: 'Please retry deletion' } });
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/api/products/product-one') return route.fulfill({ json: {
      id:'product-one', sku:'TEST', name:'Test', brand_id:'b', category_id:'c', floor_id:'first-floor',
      price:120, mrp:150, stock:0, images:[], specs:{}, variants:[],
    } });
    return route.fulfill({ json: { items:[], total:0 } });
  });
  await page.goto('/catalog/product-one');
  await page.getByTestId('delete-catalog-product').click();
  const confirmation = page.getByTestId('confirm-delete-catalog-product-confirm');
  expect(attempts).toBe(0);
  await confirmation.click();
  await expect(page.getByTestId('delete-catalog-progress')).toBeVisible();
  await expect(page.getByTestId('delete-catalog-product')).toBeDisabled();
  await expect.poll(() => attempts).toBe(1);
  release?.();
  await expect(page.getByTestId('confirm-delete-catalog-product').getByRole('alert')).toContainText('Please retry deletion');
  await confirmation.click();
  await expect(page).toHaveURL(/\/catalog$/);
  expect(attempts).toBe(2);
});

for (const floor of ['second-floor', 'third-floor']) {
  test(`critical catalog addition is not introduced on ${floor}`, async ({ page }) => {
    await mockSession(page, '/catalog', false, { floorId: floor });
    await page.goto('/catalog');
    await expect(page.getByTestId('add-catalog-product')).toHaveCount(0);
  });
}

for (const floor of ['first-floor', 'ground-floor']) {
  test(`critical catalog detail deletes selected product on ${floor}`, async ({ page }) => {
    await mockSession(page, '/catalog/product-one', false, { floorId: floor });
    await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
    await page.route('**/api/products/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/products/product-one' && route.request().method() === 'DELETE') {
        expect(route.request().headers()['x-floor-id']).toBe(floor);
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname === '/api/products/product-one') return route.fulfill({ json: {
        id: 'product-one', sku: 'SYNTHETIC', name: 'Synthetic product', brand_id: 'b', category_id: 'c', floor_id: floor,
        price: 120, mrp: 150, stock: 0, images: [], specs: {}, variants: [],
      } });
      return route.fulfill({ json: { items: [], total: 0 } });
    });
    await page.goto('/catalog/product-one');
    await page.getByTestId('delete-catalog-product').click();
    await page.getByTestId('confirm-delete-catalog-product-confirm').click();
    await expect(page).toHaveURL(/\/catalog$/);
  });
}
