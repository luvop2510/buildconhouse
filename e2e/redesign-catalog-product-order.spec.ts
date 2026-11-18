import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const builderPath = '/quotations/new';
const floor = 'first-floor';
const grohe = { id: 'grohe', name: 'Grohe', product_count: 13 };
const hansgrohe = { id: 'hansgrohe', name: 'Hansgrohe', product_count: 2 };
const categories = [
  { id: 'shower', name: 'Shower', product_count: 5 },
  { id: 'single-lever', name: 'Single Lever', product_count: 2 },
] as const;
type Category = typeof categories[number]['id'];
type Brand = typeof grohe;

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
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `mixer-extra-${index}`, sku: `MIXER-${index + 300}`, name: `Basin Mixer ${index + 3}`, price: 4300 + index * 100,
    })),
  ],
};

const initialShower = products.shower.map(product => product.sku);
const reorderedShower = ['CUBE-1', ...initialShower.slice(0, 4)];
const byAscendingPrice = [...products.shower].sort((a, b) => a.price - b.price).map(product => product.sku);

const scopeKey = (brand: string | null, category: string | null) => JSON.stringify([brand, category]);

function catalogStore(extra = 0) {
  const cards = [
    ...categories.flatMap(category => products[category.id].map(product => ({ ...product, brand: grohe.id, category: category.id }))),
    ...Array.from({ length: extra }, (_, index) => ({
      id: `large-${index}`, sku: `LARGE-${index}`, name: `Additional Shower ${index}`,
      price: 300 + index, brand: grohe.id, category: 'shower',
    })),
    ...['rain', 'hand'].map((finish, index) => ({
      id: `hans-${finish}`, sku: `HANS-${finish}`, name: `Hansgrohe ${finish}`, price: 4200 + index,
      brand: hansgrohe.id, category: 'shower',
    })),
  ];
  return {
    cards: (brand: string | null, category: string | null) =>
      cards.filter(card => (!brand || card.brand === brand) && (!category || card.category === category)),
    orders: new Map<string, { version: number; product_ids: string[] }>(),
    writes: [] as { brand: string | null; category: string | null; payload: { expected_version: number; product_ids: string[] } }[],
    quotationWrites: [] as string[],
    editorReads: 0,
    browseReads: [] as number[],
    legacyEditor: false,
    failNextSave: false,
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
  await page.route('**/api/brands**', route => route.fulfill({ json: [grohe, hansgrohe] }));
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

  await page.route('**/api/catalog/product-order**', route => {
    const request = route.request();
    const params = new URL(request.url()).searchParams;
    const brand = params.get('brand_id');
    const category = params.get('category_id');
    if (request.headers()['x-floor-id'] !== floor) {
      return route.fulfill({ status: 400, json: { detail: 'Select a catalog floor.' } });
    }
    const key = scopeKey(brand, category);
    const current = store.orders.get(key);
    const version = current?.version ?? 0;
    if (request.method() === 'GET') {
      const response = { version, can_reorder: canReorder };
      if (canReorder && params.get('include_products') === 'true' && !store.legacyEditor) {
        store.editorReads++;
        const cards = store.cards(brand, category);
        if (current) {
          const ranks = new Map(current.product_ids.map((id, index) => [id, index]));
          cards.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
        }
        return route.fulfill({ json: { ...response, products: cards.map(({ id, sku, name, price }) => ({ id, sku, name, price })) } });
      }
      return route.fulfill({ json: response });
    }
    if (!canReorder) return route.fulfill({ status: 403, json: { detail: 'Catalog reordering denied.' } });
    if (request.method() !== 'PUT') return route.fulfill({ status: 405, json: { detail: 'Use PUT to save order.' } });
    if (store.failNextSave) {
      store.failNextSave = false;
      return route.fulfill({ status: 503, json: { detail: 'Could not save the order. Try again.' } });
    }
    const payload = request.postDataJSON();
    const expectedIds = store.cards(brand, category).map(product => product.id).sort();
    if (payload.expected_version !== version || JSON.stringify([...payload.product_ids].sort()) !== JSON.stringify(expectedIds)) {
      return route.fulfill({ status: 409, json: { detail: 'The catalog order changed. Reload and try again.' } });
    }
    store.writes.push({ brand, category, payload });
    store.orders.set(key, { version: version + 1, product_ids: payload.product_ids });
    return route.fulfill({ json: { version: version + 1, can_reorder: true } });
  });

  await page.route('**/api/products/families?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const brand = params.get('brand_ids') || params.get('brand_id');
    const category = params.get('category_ids') || params.get('category_id');
    const sort = params.get('sort');
    const order = store.orders.get(scopeKey(brand, category));
    const custom = sort === 'custom' || sort === 'default';
    const cards = store.cards(brand, category);
    if (custom && order) {
      const ranks = new Map(order.product_ids.map((id, index) => [id, index]));
      cards.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
    } else if (sort === 'price_asc') {
      cards.sort((a, b) => a.price - b.price);
    }
    const skip = Number(params.get('skip') || 0);
    const limit = Number(params.get('limit') || 50);
    store.browseReads.push(limit);
    return route.fulfill({ json: {
      items: cards.slice(skip, skip + limit).map(product => ({
        family_key: product.id, family_name: product.name, sample_product_id: product.id,
        category_id: product.category, brand_id: product.brand, floor_id: floor, min_price: product.price,
        variants: [{ ...product, mrp: product.price, stock: 2, finish: 'Chrome' }],
      })),
      total: cards.length, ...(custom ? { order_version: order?.version ?? 0 } : {}),
    } });
  });
}

const productList = (page: Page) => page.getByTestId('explorer-product-list').filter({ visible: true });

async function chooseCategory(page: Page, category: Category | null, selectedBrand: Brand | null = grohe) {
  await expect(productList(page)).toBeVisible();
  const brand = page.getByTestId(`rail-brand-${selectedBrand?.name || 'all'}`);
  if (await brand.isVisible()) {
    if (!selectedBrand) { await brand.click(); return; }
    if (!category) {
      const all = page.getByTestId(`rail-cat-all-${selectedBrand.name}`);
      if (!(await all.isVisible())) await brand.click();
      await all.click();
      await expect(all).toHaveAttribute('aria-pressed', 'true');
      return;
    }
    const choice = page.getByTestId(`rail-category-select-${category}`);
    if (!(await choice.isVisible())) await brand.click();
    await choice.click();
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
  } else {
    const filters = page.getByRole('dialog', { name: 'Filters and sort', exact: true });
    await page.getByTestId('explorer-filter-toggle').filter({ visible: true }).click();
    await filters.getByTestId(`mobile-brand-${selectedBrand?.name || 'all'}`).click();
    const categoryName = categories.find(entry => entry.id === category)?.name || 'all';
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

async function dragCard(page: Page, sourceId: string, targetId: string, input: 'mouse' | 'chromium' | 'webkit' = 'mouse') {
  const list = page.getByTestId('catalog-reorder-list');
  const source = page.getByTestId(`catalog-drag-${sourceId}`);
  const sourceRow = page.getByTestId(`catalog-reorder-row-${sourceId}`);
  const destination = page.getByTestId(`catalog-reorder-row-${targetId}`);
  await source.scrollIntoViewIfNeeded();
  const box = await source.boundingBox();
  const viewport = await list.boundingBox();
  if (!box || !viewport) throw new Error('Missing catalog drag geometry');
  const x = box.x + box.width / 3;
  const y = (Math.max(box.y, viewport.y) + Math.min(box.y + box.height, viewport.y + viewport.height)) / 2;
  const grabOffset = y - box.y;
  const session = input === 'chromium' ? await page.context().newCDPSession(page) : undefined;
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) => {
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    } else {
      await source.evaluate((card, { type, x, y }) => {
        // The iPhone WebKit engine exposes Touch without a public constructor.
        // Dispatch the DOM event shape and leave trusted input to device QA.
        const point = { identifier: 1, target: card, clientX: x, clientY: y };
        const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          changedTouches: { value: [point] },
          touches: { value: type === 'touchEnd' ? [] : [point] },
        });
        card.dispatchEvent(event);
      }, { type, x, y });
    }
  };
  const move = (x: number, y: number) => input === 'mouse'
    ? page.mouse.move(x, y, { steps: 6 })
    : touch('touchMove', x, y);
  if (input === 'mouse') {
    await page.mouse.move(x, y);
    await page.mouse.down();
  } else {
    if (session) await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await touch('touchStart', x, y);
    await expect(sourceRow).toHaveAttribute('data-catalog-dragging', 'true');
  }
  let end = { x, y };
  try {
    const target = await destination.boundingBox();
    if (target && (target.y < viewport.y || target.y + grabOffset > viewport.y + viewport.height)) {
      // Hold at the viewport edge and use live row geometry after autoscroll.
      await move(x, target.y < viewport.y ? viewport.y + 12 : viewport.y + viewport.height - 12);
      await expect.poll(async () => {
        const next = await destination.boundingBox();
        return !!next && next.y + grabOffset >= viewport.y + 3 && next.y + grabOffset <= viewport.y + viewport.height - 3;
      }).toBe(true);
    }
    const visible = await destination.boundingBox();
    if (!visible) throw new Error('Destination did not scroll into view');
    end = { x: visible.x + visible.width / 3, y: visible.y + grabOffset };
    await move(end.x, end.y);
    await expect(destination).toHaveAttribute('data-catalog-drop-target', /before|after/);
    await expect(destination.locator('button')).toHaveAttribute('style', /transform: translate3d/);
  } finally {
    if (input === 'mouse') await page.mouse.up();
    else {
      await touch('touchEnd', end.x, end.y);
      await session?.detach();
    }
  }
}
test('critical middle catalog order persists per category across reload, sorts, and employee accounts', async ({ page, browser }) => {
  const store = catalogStore();
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await chooseCategory(page, 'shower');
  await expectCards(page, initialShower);
  await page.getByTestId('reorder-catalog-products').click();
  await dragCard(page, 'cube-shower', 'tempesta-100');
  await expect(page.locator('[data-catalog-reorder-row]').first()).toHaveAttribute('data-testid', 'catalog-reorder-row-cube-shower');
  expect(store.writes).toHaveLength(0);
  await page.getByTestId('catalog-cancel-order').click();
  await expectCards(page, initialShower);
  expect(store.writes).toHaveLength(0);

  await page.getByTestId('reorder-catalog-products').click();
  await dragCard(page, 'cube-shower', 'tempesta-100');
  await expect(page.locator('[data-catalog-reorder-row]').first()).toHaveAttribute('data-testid', 'catalog-reorder-row-cube-shower');
  await page.getByTestId('catalog-save-order').click();
  await expectCards(page, reorderedShower);
  expect(store.writes).toEqual([{
    brand: grohe.id, category: 'shower',
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
  test.skip(!['chromium', 'webkit'].includes(browserName) || page.viewportSize()!.width > 1024, 'Compact Chromium and WebKit touch behavior.');
  const store = catalogStore();
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await chooseCategory(page, null);
  const cards = store.cards(grohe.id, null);
  await expectCards(page, cards.map(card => card.sku));
  await page.getByTestId('reorder-catalog-products').click();
  await dragCard(page, cards[9].id, cards[1].id, browserName === 'chromium' ? 'chromium' : 'webkit');
  await expect(page.locator('[data-catalog-reorder-row]').nth(1)).toHaveAttribute('data-testid', `catalog-reorder-row-${cards[9].id}`);
  await page.getByTestId('catalog-save-order').click();
  const reordered = [cards[0], cards[9], ...cards.slice(1, 9), ...cards.slice(10)].map(card => card.sku);
  await expectCards(page, reordered);
  await page.reload();
  await chooseCategory(page, null);
  await expectCards(page, reordered);
  await chooseCategory(page, 'shower');
  await expectCards(page, initialShower);
  expect(store.writes).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical a quick touch swipe scrolls the catalog without picking up a card', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || page.viewportSize()!.width > 430, 'Use native Chromium touch dispatch.');
  const store = catalogStore(30);
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await chooseCategory(page, null);
  await page.getByTestId('reorder-catalog-products').click();
  const source = page.getByTestId('catalog-drag-tempesta-210');
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error('Missing card for touch swipe');
  const list = page.getByTestId('catalog-reorder-list');
  const initialScroll = await list.evaluate(element => element.scrollTop);
  const x = sourceBox.x + sourceBox.width / 2;
  const y = sourceBox.y + sourceBox.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const delta of [12, 40, 80, 120]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - delta }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(initialScroll + 25);
    await expect(page.locator('[data-catalog-dragging]')).toHaveCount(0);
    await expect(page.locator('[data-catalog-reorder-row]').nth(2)).toHaveAttribute('data-testid', 'catalog-reorder-row-tempesta-210');
    expect(store.writes).toHaveLength(0);
  } finally {
    await cdp.detach();
  }
});

test('critical stale catalog edits keep the saved order until the editor reloads', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || page.viewportSize()!.width < 1180, 'Representative desktop concurrency and keyboard case.');
  const store = catalogStore();
  store.legacyEditor = true;
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await chooseCategory(page, 'shower');
  await page.getByTestId('reorder-catalog-products').click();
  const dragHandle = page.getByTestId('catalog-drag-cube-shower');
  await dragHandle.press('ArrowUp');
  await expect(page.locator('[data-testid^="catalog-reorder-row-"]').nth(3)).toHaveAttribute('data-testid', 'catalog-reorder-row-cube-shower');

  const elsewhere = [products.shower[2], ...products.shower.filter(product => product.id !== 'tempesta-210')];
  store.orders.set(scopeKey(grohe.id, 'shower'), { version: 1, product_ids: elsewhere.map(product => product.id) });
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

test('critical Grohe All Products moves position ten to two and keeps category, brand and global sequences independent', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || page.viewportSize()!.width < 1180, 'Desktop full-card multi-column drag journey.');
  const store = catalogStore();
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await chooseCategory(page, null);
  const allProducts = store.cards(grohe.id, null);
  await expectCards(page, allProducts.map(card => card.sku));
  await page.getByTestId('reorder-catalog-products').click();
  await dragCard(page, allProducts[9].id, allProducts[1].id);
  await expect(page.locator('[data-catalog-reorder-row]').nth(1)).toHaveAttribute('data-testid', `catalog-reorder-row-${allProducts[9].id}`);
  const reordered = [allProducts[0], allProducts[9], ...allProducts.slice(1, 9), ...allProducts.slice(10)];
  store.failNextSave = true;
  await page.getByTestId('catalog-save-order').click();
  await expect(page.getByTestId('catalog-reorder-mode').getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-catalog-reorder-row]').nth(1)).toHaveAttribute('data-testid', `catalog-reorder-row-${allProducts[9].id}`);
  await page.getByTestId('catalog-save-order').click();
  await expectCards(page, reordered.map(card => card.sku));
  await expect(page.getByTestId('sort-custom')).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await chooseCategory(page, null);
  await expectCards(page, reordered.map(card => card.sku));
  await chooseCategory(page, 'shower');
  await expectCards(page, initialShower);
  await chooseCategory(page, null);
  await expectCards(page, reordered.map(card => card.sku));

  await chooseCategory(page, null, hansgrohe);
  await page.getByTestId('reorder-catalog-products').click();
  await dragCard(page, 'hans-hand', 'hans-rain');
  await page.getByTestId('catalog-save-order').click();
  await expectCards(page, ['HANS-hand', 'HANS-rain']);

  await chooseCategory(page, null, null);
  const globalCards = store.cards(null, null);
  await page.getByTestId('reorder-catalog-products').click();
  await dragCard(page, globalCards[1].id, globalCards[0].id);
  await page.getByTestId('catalog-save-order').click();
  await expect.poll(() => store.writes.map(({ brand }) => brand)).toEqual([grohe.id, hansgrohe.id, null]);
  await expectCards(page, [globalCards[1], globalCards[0], ...globalCards.slice(2)].map(card => card.sku));
  await chooseCategory(page, null);
  await expectCards(page, reordered.map(card => card.sku));
  expect(store.quotationWrites).toEqual([]);
});

test('critical large All Brands catalog loads one editor snapshot and saves all cards exactly once', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || page.viewportSize()!.width < 1180, 'Desktop catalog at realistic size.');
  const store = catalogStore(1603);
  await catalogSession(page, store, true);
  await page.goto(builderPath);
  await expect(productList(page).getByTestId('product-card-TEMP-100')).toBeVisible();
  const browseReads = store.browseReads.length;
  await page.getByTestId('reorder-catalog-products').click();
  const complete = store.cards(null, null);
  await expect(page.locator('[data-catalog-reorder-row]')).toHaveCount(1618);
  expect(store.editorReads).toBe(1);
  expect(store.browseReads).toHaveLength(browseReads);
  await page.getByTestId(`catalog-reorder-row-${complete[47].id}`).evaluate(row => row.scrollIntoView({ block: 'center' }));
  await dragCard(page, complete[52].id, complete[47].id);
  await page.getByTestId('catalog-save-order').click();
  await expect.poll(() => store.writes.length).toBe(1);
  const ids = store.writes[0].payload.product_ids;
  expect(ids).toHaveLength(1618);
  expect(new Set(ids).size).toBe(1618);
  expect(ids[47]).toBe(complete[52].id);
  expect(ids[48]).toBe(complete[47].id);
  expect(store.browseReads.every(limit => limit === 50)).toBe(true);
  expect(store.quotationWrites).toEqual([]);
});
