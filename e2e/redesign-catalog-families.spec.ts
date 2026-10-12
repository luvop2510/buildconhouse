import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function familyCatalog(page: Page, path: string) {
  await mockSession(page, path, false);
  const mutations: { path: string; body: any }[] = [];
  const silver = { id: 'family-silver', sku: 'SILVER-SKU', name: 'Family Basin', price: 100, mrp: 120, stock: 3, finish: 'Chrome', colour: 'Silver', size: '30 cm', images: [], specs: {} };
  const black = { ...silver, id: 'family-black', sku: 'BLACK-SKU', price: 150, colour: 'Black', finish: 'Black', variant_label: '' };
  const brands = [{ id: 'brand-a', name: 'Brand A', product_count: 1 }, { id: 'brand-b', name: 'Brand B', product_count: 1 }];
  const categories = [{ id: 'basins', name: 'Basins', product_count: 1 }, { id: 'showers', name: 'Showers', product_count: 1 }];
  const family = () => ({ family_key: 'family-basin', family_name: 'Family Basin', brand_id: 'brand-a', category_id: 'basins', sample_product_id: silver.id, floor_id: 'first-floor', min_price: 100, max_price: 150, product_count: 2, variants: [silver, black] });
  await page.route('**/api/brands**', route => route.fulfill({ json: brands }));
  await page.route('**/api/categories**', route => route.fulfill({ json: categories }));
  await page.route('**/api/catalog/facets**', route => route.fulfill({ json: { finishes: [{ value: 'Chrome' }, { value: 'Black' }], colours: [{ value: 'Silver' }, { value: 'Black' }], sizes: [{ value: '30 cm' }, { value: '50 cm' }] } }));
  await page.route('**/api/catalog/hierarchy**', route => route.fulfill({ json: { tree: brands.map(brand => ({ brand, product_count: 1, categories: categories.map(category => ({ category, subcategories: [] })) })) } }));
  await page.route('**/api/products/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/products/families') return route.fulfill({ json: { total: 1, items: [family()] } });
    if (url.pathname === '/api/products/family-black' && route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      mutations.push({ path: url.pathname, body }); Object.assign(black, body);
    }
    if (url.pathname === '/api/products/family-black') return route.fulfill({ json: { ...black, brand_id: 'brand-a', category_id: 'basins', floor_id: 'first-floor', family_key: 'family-basin' } });
    if (url.pathname === '/api/products/family-silver') return route.fulfill({ json: { ...silver, brand_id: 'brand-a', category_id: 'basins', floor_id: 'first-floor', family_key: 'family-basin' } });
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.route('**/api/referrers**', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/recent**', route => route.fulfill({ json: [] }));
  return { mutations, black };
}

test('critical catalog multi-select keeps two brands categories and finishes in its backend query', async ({ page }) => {
  await familyCatalog(page, '/catalog');
  await page.goto('/catalog');
  await expect(page.getByTestId('family-family-basin')).toHaveCount(1);
  await page.getByRole('button', { name: 'Catalog filters', exact: true }).click();
  const sheet = page.getByTestId('catalog-filters');
  // Categorical filters load immediately. Observe before selecting the last
  // filter so a fast response cannot finish before the listener is installed.
  const response = page.waitForResponse(res => {
    const url = new URL(res.url());
    return url.pathname === '/api/products/families' && url.searchParams.getAll('brand_ids').length === 2 && url.searchParams.getAll('category_ids').length === 2 && url.searchParams.getAll('finishes').length === 2;
  });
  for (const label of ['Brand A', 'Brand B', 'Basins', 'Showers', 'Chrome', 'Black']) await sheet.getByRole('button', { name: label, exact: true }).first().click();
  await sheet.getByRole('button', { name: 'Show results', exact: true }).click();
  await response;
  await expect(page.getByTestId('family-family-basin')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical sanitary catalog stays visible after a delayed floor request is cancelled', async ({ page }) => {
  await familyCatalog(page, '/catalog');
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const pending = new Promise<void>(resolve => { releaseFirst = resolve; });
  let holdFirst = true;
  await page.route('**/api/products/families?**', async route => {
    const floor = route.request().headers()['x-floor-id'];
    if (floor === 'first-floor' && holdFirst) {
      holdFirst = false;
      firstStarted();
      await pending;
    }
    const name = floor === 'first-floor' ? 'Sanitary Basin' : 'Tile Family';
    await route.fulfill({ json: { total: 1, items: [{ family_key: floor, family_name: name, brand_id: 'brand-a', category_id: 'basins', sample_product_id: `${floor}-product`, floor_id: floor, min_price: 100, max_price: 100, product_count: 1, variants: [{ id: `${floor}-product`, sku: `${floor}-sku`, price: 100, mrp: 100 }] }] } });
  });
  await page.goto('/catalog');
  await started;
  await page.getByTestId('floor-switcher').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Ground Floor', exact: true }).click();
  releaseFirst();
  await expect(page.getByTestId('family-ground-floor')).toBeVisible();
  await expect(page.getByTestId('family-first-floor')).toHaveCount(0);
  await page.getByTestId('floor-switcher').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'The Sanitary Bathroom', exact: true }).click();
  await expect(page.getByTestId('family-first-floor')).toBeVisible();
  await expect(page.getByTestId('family-ground-floor')).toHaveCount(0);
  await expect(page.getByText("Couldn't load the catalog", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical grouped builder selects second SKU and persists its color name without changing the first SKU', async ({ page }) => {
  const fixture = await familyCatalog(page, '/quotations/new');
  await page.goto('/quotations/new');
  const browse = page.getByTestId('empty-browse-catalog');
  if (await browse.isVisible()) await browse.click();
  await expect(page.getByTestId('product-card-SILVER-SKU')).toBeVisible();
  await expect(page.getByTestId('product-card-SILVER-SKU')).toHaveCount(1);
  await expect(page.getByTestId('product-card-BLACK-SKU')).toHaveCount(0);
  await page.getByRole('button', { name: 'View Family Basin', exact: true }).click();
  await page.getByTestId('pm-variant-BLACK-SKU').click();
  await page.getByTestId('pm-edit-color-variant-name').click();
  await page.getByTestId('pm-color-variant-name').fill('Midnight Black');
  await page.getByTestId('pm-save-color-variant-name').click();
  await expect(page.getByTestId('pm-variant-BLACK-SKU')).toHaveAccessibleName('Midnight Black · 30 cm, selected');
  expect(fixture.mutations).toEqual([{ path: '/api/products/family-black', body: { variant_label: 'Midnight Black' } }]);
  await page.getByTestId('pm-variant-SILVER-SKU').click();
  await expect(page.getByTestId('pm-variant-SILVER-SKU')).toHaveAccessibleName('Chrome · 30 cm · Silver, selected');
  expect(fixture.black.sku).toBe('BLACK-SKU');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
