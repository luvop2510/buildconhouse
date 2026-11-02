import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const floor of ['first-floor', 'ground-floor']) {
  test(`critical custom catalog product is addable on ${floor}`, async ({ page }) => {
    await mockSession(page, '/catalog', false, { floorId: floor });
    await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
    await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
    await page.route('**/api/catalog/facets**', route => route.fulfill({ json: {} }));
    await page.route('**/api/catalog/hierarchy**', route => route.fulfill({ json: { tree: [] } }));
    await page.route('**/api/products/families**', route => route.fulfill({ json: { items: [], total: 0 } }));
    let created = 0;
    await page.route('**/api/products/catalog-custom', route => {
      const body = route.request().postDataJSON();
      expect(body.name).toBe('Synthetic product');
      expect(body.price).toBe(120);
      expect(route.request().headers()['x-floor-id']).toBe(floor);
      created++;
      return route.fulfill({ json: { id: 'new', floor_id: floor } });
    });
    await page.goto('/catalog');
    await page.getByTestId('add-catalog-product').click();
    await page.getByTestId('custom-catalog-name').fill('Synthetic product');
    await page.getByTestId('custom-catalog-price').fill('120');
    await page.getByTestId('save-catalog-custom-product').click();
    await expect.poll(() => created).toBe(1);
    await expect(page.getByTestId('save-catalog-custom-product')).toHaveCount(0);
  });
}

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
    await expect(page).toHaveURL(/\/catalog$/);
  });
}
