import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const brands = [
  { id: 'grohe', name: 'GROHE', product_count: 2 },
  { id: 'hansgrohe', name: 'Hansgrohe', product_count: 2 },
  { id: 'vitra', name: 'Vitra', product_count: 2 },
  { id: 'geberit', name: 'Geberit', product_count: 2 },
  { id: 'oyster', name: 'Oyster', product_count: 2 },
];
const categories = ['basins', 'showers'].map(id => ({ id, name: id === 'basins' ? 'Basins' : 'Showers', product_count: 1 }));

async function fixture(page: Page, restore: boolean | 'incompatible' = false, failBrandCategories = false) {
  await mockSession(page, '/quotations/new', false);
  const requests: URLSearchParams[] = [];
  await page.route('**/api/brands**', route => route.fulfill({ json: brands }));
  let categoryFailure = failBrandCategories;
  await page.route('**/api/categories**', route => {
    if (categoryFailure && new URL(route.request().url()).searchParams.get('brand_id') === 'grohe') return route.fulfill({ status: 503, json: { detail: 'Temporary category failure' } });
    return route.fulfill({ json: categories });
  });
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/catalog/facets**', route => route.fulfill({ json: {
    finishes: [{ value: 'Chrome' }], colours: [{ value: 'White' }], sizes: [{ value: 'Standard' }],
  } }));
  await page.route('**/api/products/families?**', route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const selectedBrands = params.getAll('brand_ids');
    const selectedCategories = params.getAll('category_ids');
    const items = brands.filter(brand => !selectedBrands.length || selectedBrands.includes(brand.id))
      .flatMap(brand => categories.filter(category => !selectedCategories.length || selectedCategories.includes(category.id))
        .map(category => ({
          family_key: `${brand.id}-${category.id}`, family_name: `${brand.name} ${category.name}`, brand_id: brand.id, category_id: category.id, min_price: 100,
          variants: [{ id: `${brand.id}-${category.id}`, sku: `${brand.id}-${category.id}`, name: `${brand.name} ${category.name}`, price: 100, mrp: 100, stock: 1, finish: 'Chrome' }],
        })));
    return route.fulfill({ json: { total: items.length, items } });
  });
  if (restore) await page.route(/\/api\/quotations\/q-legacy(?:\?.*)?$/, route => route.fulfill({ json: {
    id: 'q-legacy', number: 'Q-LEGACY', customer_name: 'Saved buyer', status: 'draft', rooms: ['Master Bath'], items: [],
    ui_state: { selectedBrandIds: ['grohe', 'hansgrohe'], selectedCategoryIds: restore === 'incompatible' ? ['hans-only', 'basins'] : ['basins', 'showers'], selectedFinishes: ['Chrome'], selectedColours: ['White'] },
  } }));
  await page.goto(`/quotations/new${restore ? '?quotationId=q-legacy' : ''}`);
  await expect(page.getByTestId('builder-back')).toBeVisible();
  const addFirst = page.getByTestId('mobile-add-first');
  if (await addFirst.isVisible()) await addFirst.click();
  const filterToggle = (await controlRoot(page)).getByTestId('explorer-filter-toggle');
  const compact = await filterToggle.isVisible();
  if (compact) await filterToggle.click();
  return { requests, compact, recoverCategories: () => { categoryFailure = false; } };
}

async function controlRoot(page: Page) {
  const picker = page.getByRole('dialog', { name: 'Add products', exact: true });
  return await picker.isVisible() ? picker : page;
}

async function selectBrand(page: Page, name: string, compact: boolean) {
  await (await controlRoot(page)).getByTestId(`${compact ? 'mobile' : 'rail'}-brand-${name}`).click();
}
async function selectCategory(page: Page, id: string, compact: boolean) {
  await (await controlRoot(page)).getByTestId(compact ? `mobile-category-${categories.find(c => c.id === id)!.name}` : `rail-category-select-${id}`).click();
}
async function expectScope(page: Page, brand: string | null, category: string | null) {
  const matching = brands.filter(b => !brand || b.id === brand).flatMap(b => categories.filter(c => !category || c.id === category).map(c => `add-${b.id}-${c.id}`));
  const root = await controlRoot(page);
  const productAddButtons = brands.map(brand => `[data-testid^="add-${brand.id}-"]`).join(',');
  await expect(root.locator(productAddButtons)).toHaveCount(matching.length);
  for (const id of matching) await expect(root.getByTestId(id)).toBeAttached();
}

test('critical quotation replaces brand and category choices across every supplier and clears previous scopes', async ({ page }) => {
  const { requests, compact } = await fixture(page);
  await expectScope(page, null, null);
  for (const brand of brands) {
    await selectBrand(page, brand.name, compact);
    await expectScope(page, brand.id, null);
    const root = await controlRoot(page);
    await expect(root.getByTestId(`${compact ? 'mobile' : 'rail'}-brand-${brand.name}`)).toHaveAttribute('aria-pressed', 'true');
    for (const previousBrand of brands.filter(previous => previous.id !== brand.id)) {
      await expect(root.getByTestId(`${compact ? 'mobile' : 'rail'}-brand-${previousBrand.name}`)).toHaveAttribute('aria-pressed', 'false');
    }
    for (const category of categories) {
      await selectCategory(page, category.id, compact);
      await expectScope(page, brand.id, category.id);
      await expect((await controlRoot(page)).getByTestId(compact ? `mobile-category-${category.name}` : `rail-category-select-${category.id}`)).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(root.getByTestId(compact ? 'mobile-category-Basins' : 'rail-category-select-basins')).toHaveAttribute('aria-pressed', 'false');
    // Selecting the current category again retains it, rather than toggling off.
    await selectCategory(page, 'showers', compact);
    await expectScope(page, brand.id, 'showers');
  }
  await (await controlRoot(page)).getByTestId(compact ? 'mobile-category-all' : 'rail-cat-all-Oyster').click();
  await expectScope(page, 'oyster', null);
  await (await controlRoot(page)).getByTestId(`${compact ? 'mobile' : 'rail'}-brand-all`).click();
  await expectScope(page, null, null);
  expect(requests.every(params => params.getAll('brand_ids').length <= 1 && params.getAll('category_ids').length <= 1)).toBe(true);
  await expect(page.getByText('Finish · select multiple', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Color · select multiple', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical legacy quotation restores one brand and category without hidden finish or color filters', async ({ page }) => {
  const { requests, compact } = await fixture(page, true);
  await expectScope(page, 'grohe', 'basins');
  expect(requests.some(params => params.getAll('brand_ids').join() === 'grohe' && params.getAll('category_ids').join() === 'basins')).toBe(true);
  expect(requests.every(params => !params.has('finishes') && !params.has('colours'))).toBe(true);
  await selectBrand(page, 'Hansgrohe', compact);
  await expectScope(page, 'hansgrohe', null);
});

test('critical legacy mixed-brand category is cleared when it does not belong to the restored brand', async ({ page }) => {
  await fixture(page, 'incompatible');
  await expectScope(page, 'grohe', null);
});

test('critical failed quotation brand categories recover through an explicit retry', async ({ page }) => {
  const { compact, recoverCategories } = await fixture(page, false, true);
  await expectScope(page, null, null);
  await selectBrand(page, 'GROHE', compact);
  await expectScope(page, 'grohe', null);
  const retry = (await controlRoot(page)).getByTestId(compact ? 'explorer-category-retry' : 'rail-categories-retry-grohe');
  await expect(retry).toBeVisible();
  recoverCategories();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await selectCategory(page, 'showers', compact);
  await expectScope(page, 'grohe', 'showers');
});
