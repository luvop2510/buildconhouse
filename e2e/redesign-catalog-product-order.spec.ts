import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const builderPath = '/quotations/new';
const floor = 'first-floor';
const grohe = { id: 'grohe', name: 'Grohe', product_count: 7 };
const categories = [
  { id: 'shower', name: 'Shower', product_count: 5 },
  { id: 'single-lever', name: 'Single Lever', product_count: 2 },
] as const;
type Scope = typeof categories[number]['id'];

const products = {
  shower: [
    { id: 'tempesta-100', sku: 'TEMP-100', name: 'Tempesta 100', price: 5200 },
    { id: 'tempesta-cosmo', sku: 'TEMP-COSMO', name: 'Tempesta Cosmopolitan', price: 1600 },
    { id: 'tempesta-210', sku: 'TEMP-210', name: 'Tempesta 210', price: 4100 },
    { id: 'tempesta-250', sku: 'TEMP-250', name: 'Tempesta 250', price: 3100 },
    { id: 'cube-shower', sku: 'CUBE-1', name: 'Cube Shower', price: 2500 },
  ],
  'single-lever': [
    { id: 'mixer-100', sku: 'MIXER-100', name: 'Basin Mixer', price: 3300 },
    { id: 'mixer-200', sku: 'MIXER-200', name: 'Tall Basin Mixer', price: 4200 },
  ],
};

const initialShower = products.shower.map(product => product.sku);
const reorderedShower = ['CUBE-1', ...initialShower.slice(0, 4)];
const byAscendingPrice = [...products.shower].sort((a, b) => a.price - b.price).map(product => product.sku);

function catalogStore() {
  return {
    orders: new Map<Scope, { version: number; product_ids: string[] }>(),
    writes: [] as { category: Scope; payload: { expected_version: number; product_ids: string[] } }[],
    quotationWrites: [] as string[],
  };
}

async function catalogSession(page: Page, store: ReturnType<typeof catalogStore>, canReorder: boolean) {
  await mockSession(page, builderPath, false, {
    grants: [],
    staff: {
      id: canReorder ? 'catalog-owner' : 'sales-employee',
      full_name: canReorder ? 'Catalog Owner' : 'Sales Employee',
      email: canReorder ? 'owner@example.test' : 'sales@example.test',
      role: canReorder ? 'owner' : 'sales',
      active: true,
      floor_ids: [floor],
    },
  });
  await page.route('**/api/customers**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [grohe] }));
  await page.route('**/api/categories**', route => route.fulfill({ json: categories }));
  await page.route('**/api/catalog/facets**', route => route.fulfill({ json: {} }));
  await page.route('**/api/referrers**', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations**', route => {
    const request = route.request();
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/quotations/recent') {
      return route.fulfill({ json: [] });
    }
    if (request.method() !== 'GET') store.quotationWrites.push(request.method());
    return route.fallback();
  });

  await page.route('**/api/catalog/product-order?**', route => {
    const request = route.request();
    const params = new URL(request.url()).searchParams;
    const category = categories.find(entry => entry.id === params.get('category_id'))?.id;
    if (!category || params.get('brand_id') !== grohe.id || request.headers()['x-floor-id'] !== floor) {
      return route.fulfill({ status: 400, json: { detail: 'Select a brand and category.' } });
    }
    const current = store.orders.get(category);
    const version = current?.version ?? 0;
    if (request.method() === 'GET') return route.fulfill({ json: { version, can_reorder: canReorder } });
    if (!canReorder) return route.fulfill({ status: 403, json: { detail: 'Catalog reordering denied.' } });
    if (request.method() !== 'PUT') return route.fulfill({ status: 405, json: { detail: 'Use PUT to save order.' } });
    const payload = request.postDataJSON();
    const expectedIds = products[category].map(product => product.id).sort();
    if (payload.expected_version !== version || JSON.stringify([...payload.product_ids].sort()) !== JSON.stringify(expectedIds)) {
      return route.fulfill({ status: 409, json: { detail: 'The catalog order changed. Reload and try again.' } });
    }
    store.writes.push({ category, payload });
    store.orders.set(category, { version: version + 1, product_ids: payload.product_ids });
    return route.fulfill({ json: { version: version + 1, can_reorder: true } });
  });

  await page.route('**/api/products/families?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const brand = params.get('brand_ids') || params.get('brand_id');
    const category = params.get('category_ids') || params.get('category_id');
    const groups = categories.filter(entry => !category || entry.id === category);
    const cards = groups.flatMap(({ id }) => {
      if (brand && brand !== grohe.id) return [];
      const ordered = [...products[id]];
      const custom = store.orders.get(id);
      if (params.get('sort') === 'custom' && custom) {
        ordered.sort((a, b) => custom.product_ids.indexOf(a.id) - custom.product_ids.indexOf(b.id));
      } else if (params.get('sort') === 'price_asc') {
        ordered.sort((a, b) => a.price - b.price);
      }
      return ordered.map(product => ({
        family_key: product.id,
        family_name: product.name,
        sample_product_id: product.id,
        category_id: id,
        brand_id: grohe.id,
        floor_id: floor,
        min_price: product.price,
        variants: [{ ...product, mrp: product.price, stock: 2, finish: 'Chrome' }],
      }));
    });
    const skip = Number(params.get('skip') || 0);
    const limit = Number(params.get('limit') || 50);
    return route.fulfill({ json: { items: cards.slice(skip, skip + limit), total: cards.length } });
  });
}

const productList = (page: Page) => page.getByTestId('explorer-product-list').filter({ visible: true });

async function chooseCategory(page: Page, category: Scope) {
  await expect(productList(page)).toBeVisible();
  const brand = page.getByTestId('rail-brand-Grohe');
  if (await brand.isVisible()) {
    const choice = page.getByTestId(`rail-category-select-${category}`);
    if (!(await choice.isVisible())) await brand.click();
    await choice.click();
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
  } else {
    const filters = page.getByRole('dialog', { name: 'Filters and sort', exact: true });
    await page.getByTestId('explorer-filter-toggle').filter({ visible: true }).click();
    await filters.getByTestId('mobile-brand-Grohe').click();
    const categoryName = categories.find(entry => entry.id === category)!.name;
    await filters.getByTestId(`mobile-category-${categoryName}`).click();
    await filters.getByTestId('explorer-filter-done').click();
    await expect(filters).toBeHidden();
  }
}

async function selectSort(page: Page, sort: 'price_asc' | 'custom') {
  const filterToggle = page.getByTestId('explorer-filter-toggle').filter({ visible: true });
  if (await filterToggle.isVisible()) {
    const filters = page.getByRole('dialog', { name: 'Filters and sort', exact: true });
    await filterToggle.click();
    await filters.getByTestId(`sort-${sort}`).click();
    await filters.getByTestId('explorer-filter-done').click();
  } else {
    await page.getByTestId(`sort-${sort}`).click();
  }
}

async function expectCards(page: Page, skuOrder: string[]) {
  const cards = productList(page).locator('[data-testid^="product-card-"]');
  await expect.poll(() => cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')!.replace('product-card-', '')))).toEqual(skuOrder);
}

async function dragLastShowerToTop(page: Page, touch = false) {
  const list = page.getByTestId('catalog-reorder-list');
  const handle = page.getByTestId('catalog-drag-cube-shower');
  const destination = page.getByTestId('catalog-reorder-row-tempesta-100');
  await handle.scrollIntoViewIfNeeded();
  const sourceBox = await handle.boundingBox();
  const viewport = await list.boundingBox();
  if (!sourceBox || !viewport) throw new Error('Missing catalog drag geometry');
  const x = sourceBox.x + sourceBox.width / 2;
  const start = (Math.max(sourceBox.y, viewport.y) + Math.min(sourceBox.y + sourceBox.height, viewport.y + viewport.height)) / 2;
  const topEdge = Math.max(viewport.y, 0) + 12;
  const session = touch ? await page.context().newCDPSession(page) : undefined;
  const move = (y: number) => session
    ? session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
    : page.mouse.move(x, y, { steps: 6 });
  if (session) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
  } else {
    await page.mouse.move(x, start);
    await page.mouse.down();
  }
  try {
    // Hold at the edge so the real catalog scrolls if the fifth row pushed
    // the first row out of the viewport. Then use the row's live bounds.
    await move(topEdge);
    await expect.poll(async () => {
      const target = await destination.boundingBox();
      return target !== null && target.y >= viewport.y - 2;
    }).toBe(true);
    const target = await destination.boundingBox();
    if (!target) throw new Error('First product did not scroll into view');
    await move(target.y + Math.min(22, target.height / 4));
    await expect(destination).toHaveAttribute('data-catalog-drop-target', 'before');
  } finally {
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else {
      await page.mouse.up();
    }
  }
  await expect(list.locator('[data-testid^="catalog-reorder-row-"]').first()).toHaveAttribute('data-testid', 'catalog-reorder-row-cube-shower');
}

test('critical middle catalog order persists per category across reload, sorts, and employee accounts', async ({ page, browser }) => {
  const store = catalogStore();
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await chooseCategory(page, 'shower');
  await expectCards(page, initialShower);
  await page.getByTestId('reorder-catalog-products').click();
  await dragLastShowerToTop(page);
  expect(store.writes).toHaveLength(0);
  await page.getByTestId('catalog-cancel-order').click();
  await expectCards(page, initialShower);
  expect(store.writes).toHaveLength(0);

  await page.getByTestId('reorder-catalog-products').click();
  await dragLastShowerToTop(page);
  await page.getByTestId('catalog-save-order').click();
  await expectCards(page, reorderedShower);
  expect(store.writes).toEqual([{
    category: 'shower',
    payload: { expected_version: 0, product_ids: ['cube-shower', ...products.shower.slice(0, 4).map(product => product.id)] },
  }]);
  await expect(productList(page).getByTestId('add-CUBE-1')).toBeEnabled();

  await page.reload();
  await chooseCategory(page, 'shower');
  await expectCards(page, reorderedShower);
  await chooseCategory(page, 'single-lever');
  await expectCards(page, products['single-lever'].map(product => product.sku));
  await chooseCategory(page, 'shower');
  await expectCards(page, reorderedShower);
  await selectSort(page, 'price_asc');
  await expectCards(page, byAscendingPrice);
  await selectSort(page, 'custom');
  await expectCards(page, reorderedShower);
  expect(store.writes).toHaveLength(1);
  expect(store.quotationWrites).toEqual([]);

  const employeeContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: page.viewportSize()! });
  try {
    const employee = await employeeContext.newPage();
    await catalogSession(employee, store, false);
    await employee.goto(builderPath);
    const permission = employee.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/catalog/product-order' && url.searchParams.get('category_id') === 'shower';
    });
    await chooseCategory(employee, 'shower');
    expect(await (await permission).json()).toEqual({ version: 1, can_reorder: false });
    await expectCards(employee, reorderedShower);
    await expect(employee.getByTestId('reorder-catalog-products')).toHaveCount(0);
    await expect(employee.getByTestId('catalog-save-order')).toHaveCount(0);
  } finally {
    await employeeContext.close();
  }
});

test('critical touch drag saves the middle catalog order on a compact touchscreen layout', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || page.viewportSize()!.width > 1024, 'Compact Chromium uses CDP to dispatch a native touch sequence.');
  const store = catalogStore();
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await chooseCategory(page, 'shower');
  await expectCards(page, initialShower);
  await page.getByTestId('reorder-catalog-products').click();
  await dragLastShowerToTop(page, true);
  await page.getByTestId('catalog-save-order').click();
  await expectCards(page, reorderedShower);
  await page.reload();
  await chooseCategory(page, 'shower');
  await expectCards(page, reorderedShower);
  expect(store.writes).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical stale catalog edits keep the saved order until the editor reloads', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || page.viewportSize()!.width < 1180, 'Representative desktop concurrency and keyboard case.');
  const store = catalogStore();
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await chooseCategory(page, 'shower');
  await page.getByTestId('reorder-catalog-products').click();
  const dragHandle = page.getByTestId('catalog-drag-cube-shower');
  await dragHandle.press('ArrowUp');
  await expect(page.locator('[data-testid^="catalog-reorder-row-"]').nth(3)).toHaveAttribute('data-testid', 'catalog-reorder-row-cube-shower');

  const elsewhere = [products.shower[2], ...products.shower.filter(product => product.id !== 'tempesta-210')];
  store.orders.set('shower', { version: 1, product_ids: elsewhere.map(product => product.id) });
  await page.getByTestId('catalog-save-order').click();
  await expect(page.getByTestId('catalog-reorder-mode').getByRole('alert')).toContainText('The catalog order changed');
  await expect(page.getByTestId('catalog-save-order')).toHaveCount(0);
  expect(store.writes).toHaveLength(0);

  await page.getByTestId('catalog-reload-order').click();
  await expect(page.locator('[data-testid^="catalog-reorder-row-"]').first()).toHaveAttribute('data-testid', 'catalog-reorder-row-tempesta-210');
  await page.getByTestId('catalog-cancel-order').click();
  await selectSort(page, 'price_asc');
  await selectSort(page, 'custom');
  await expectCards(page, elsewhere.map(product => product.sku));
});
