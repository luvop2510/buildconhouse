import { expect, test, type Page } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import { mockSession } from './audit-fixtures';

const LATENCY_MS = 200;
const product = {
  id: 'performance-product', name: 'Performance basin', sku: 'PERFORMANCE-1',
  brand_id: 'performance-brand', category_id: 'performance-category',
  price: 1000, mrp: 1000, images: [], tags: [], stock: 1,
};
const family = {
  family_key: 'performance-family', family_name: product.name,
  brand_id: product.brand_id, category_id: product.category_id,
  sample_product_id: product.id, min_price: 1000, max_price: 1000,
  product_count: 1, variants: [product],
};

async function fixtureCatalog(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const started = performance.now();
  const reads: { path: string; query: string; atMs: number; floor: string | undefined }[] = [];
  const completed: { path: string; atMs: number }[] = [];
  const external: string[] = [];
  const mutations: string[] = [];
  const errors: string[] = [];
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.origin);
      return route.abort();
    }
    return route.continue();
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${url.pathname}`);
    reads.push({ path: url.pathname, query: url.search, atMs: performance.now() - started, floor: request.headers()['x-floor-id'] });
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) completed.push({ path: url.pathname, atMs: performance.now() - started });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const tasks: number[] = [];
    (window as any).__performanceLongTasks = tasks;
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) tasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    }
  });
  await mockSession(page, '/catalog', false);
  const replies: Record<string, unknown> = {
    '/api/brands': [{ id: product.brand_id, name: 'Performance Brand' }],
    '/api/categories': [{ id: product.category_id, name: 'Basins' }],
    '/api/catalog/facets': {},
    '/api/catalog/hierarchy': { tree: [{ brand: { id: product.brand_id, name: 'Performance Brand' }, product_count: 1, categories: [{ category: { id: product.category_id, name: 'Basins' }, subcategories: [] }] }] },
    '/api/products/families': { total: 1, items: [family] },
    '/api/products': { total: 1, items: [product] },
  };
  await page.route('**/api/**', async route => {
    // Delaying every request makes redundant requests and serial waterfalls
    // observable without relying on production database or network state.
    await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
    const path = new URL(route.request().url()).pathname;
    if (Object.hasOwn(replies, path)) return route.fulfill({ json: replies[path] });
    return route.fallback();
  });
  return { started, reads, completed, external, mutations, errors };
}

test('cold catalog loads one bounded page promptly on each device', async ({ page, baseURL }, info) => {
  const data = await fixtureCatalog(page, baseURL!);
  const navigationStarted = performance.now();
  await page.goto('/catalog', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('family-performance-family')).toBeVisible();
  const readyMs = performance.now() - navigationStarted;
  const familyReads = data.reads.filter(read => read.path === '/api/products/families');
  const floorResponse = data.completed.find(read => read.path === '/api/settings/floor-access');
  const requestAfterFloorMs = familyReads[0].atMs - floorResponse!.atMs;
  const referencesStarted = data.reads.find(read => read.path === '/api/brands')!.atMs;
  const requestAfterReferencesMs = familyReads[0].atMs - referencesStarted;
  const summary = {
    device: info.project.name, fixtureLatencyMs: LATENCY_MS, readyMs,
    requestAfterFloorMs, requestAfterReferencesMs, reads: data.reads,
    longTasksMs: await page.evaluate(() => (window as any).__performanceLongTasks),
  };
  await info.attach('catalog-startup-timing', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
  console.log(`PERFORMANCE ${JSON.stringify(summary)}`);
  // A release-export regression must not consume the user's reported 5–10s
  // budget merely mounting the browser UI against a 200ms API fixture.
  expect(readyMs).toBeLessThan(2500);
  // Search debounce belongs to typed searches, never to opening the page.
  expect(requestAfterReferencesMs).toBeLessThan(180);
  expect(familyReads).toHaveLength(1);
  expect(new URLSearchParams(familyReads[0].query).get('limit')).toBe('60');
  expect(familyReads[0].floor).toBe('first-floor');
  for (const path of ['/api/auth/me', '/api/settings/floor-access', '/api/brands', '/api/categories', '/api/catalog/hierarchy']) {
    expect(data.reads.filter(read => read.path === path), path).toHaveLength(1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(data.external).toEqual([]);
  expect(data.mutations).toEqual([]);
  expect(data.errors).toEqual([]);
});

test('customer identity and tabs remain usable while related history is pending', async ({ page, baseURL }, info) => {
  const data = await fixtureCatalog(page, baseURL!);
  const customerId = 'performance-customer';
  const held: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/customers/${customerId}`) {
      await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
      return route.fulfill({ json: { id: customerId, name: 'Fast Customer', email: 'fast@example.test', phone: '9909906652', address: 'Fast customer address', purchase_completion_status: 'active' } });
    }
    if ((url.pathname === '/api/quotations' || url.pathname === '/api/purchase-orders' || url.pathname === '/api/godown-stock/customer-transfers') && url.searchParams.get('customer_id') === customerId || url.pathname === `/api/activity/customer/${customerId}` || url.pathname === `/api/purchases/customers/${customerId}/workspace`) {
      held.push(url.pathname);
      await pending;
      return route.fulfill({ status: 503, json: { detail: 'Fixture related history unavailable' } });
    }
    return route.fallback();
  });
  try {
    const navigationStarted = performance.now();
    await page.goto(`/customers/${customerId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Fast Customer', { exact: true }).first()).toBeVisible();
    const readyMs = performance.now() - navigationStarted;
    await info.attach('customer-primary-ready', { body: JSON.stringify({ device: info.project.name, readyMs, held, reads: data.reads }, null, 2), contentType: 'application/json' });
    await expect(page.getByText('Fast customer address', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('add-to-followups-btn')).toBeVisible();
    expect(held).toEqual(expect.arrayContaining(['/api/quotations', '/api/purchase-orders', `/api/activity/customer/${customerId}`]));
    await page.getByTestId('customer-tab-quotations').click();
    await expect(page.getByText('Loading quotations…', { exact: true })).toBeVisible();
    await expect(page.getByText('No quotations yet', { exact: true })).toHaveCount(0);
    expect(data.completed.some(read => held.includes(read.path))).toBe(false);
    expect(data.reads.filter(read => read.path === `/api/customers/${customerId}`)).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(data.external).toEqual([]);
    expect(data.mutations).toEqual([]);
    expect(data.errors).toEqual([]);
  } finally { release(); }
});

test('quotation content renders while breakdown, purchase links and activity are pending', async ({ page, baseURL }, info) => {
  const data = await fixtureCatalog(page, baseURL!);
  const quotationId = 'performance-quotation';
  const held: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/quotations/${quotationId}`) {
      await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
      return route.fulfill({ json: {
        id: quotationId, number: 'Q-PERFORMANCE', customer_name: 'Fast Quotation Customer', status: 'draft', floor_id: 'first-floor',
        items: [{ id: 'line', sku: 'FAST-1', name: 'Fast Quotation Basin', qty: 1, unit_price: 200, discount_pct: 0, room: 'Bathroom' }], rooms: ['Bathroom'],
        subtotal: 200, discount_total: 0, grand_total: 200, created_at: '2026-10-01T10:00:00Z', created_by_name: 'Audit Owner',
      } });
    }
    if (url.pathname === `/api/quotations/${quotationId}/breakdown` || url.pathname === `/api/activity/quotation/${quotationId}` || url.pathname === '/api/purchase-orders' && url.searchParams.get('quotation_id') === quotationId) {
      held.push(url.pathname);
      await pending;
      return route.fulfill({ status: 503, json: { detail: 'Fixture related history unavailable' } });
    }
    return route.fallback();
  });
  try {
    const navigationStarted = performance.now();
    await page.goto(`/quotations/${quotationId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Q-PERFORMANCE', { exact: true })).toBeVisible();
    const readyMs = performance.now() - navigationStarted;
    await info.attach('quotation-primary-ready', { body: JSON.stringify({ device: info.project.name, readyMs, held, reads: data.reads }, null, 2), contentType: 'application/json' });
    await expect(page.getByText('Fast Quotation Customer', { exact: true })).toBeVisible();
    await expect(page.getByText('Grand total', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Loading line prices…', { exact: true })).toBeVisible();
    await expect(page.getByTestId('edit-quotation')).toBeVisible();
    expect(held).toEqual(expect.arrayContaining([`/api/quotations/${quotationId}/breakdown`, `/api/activity/quotation/${quotationId}`, '/api/purchase-orders']));
    expect(data.completed.some(read => held.includes(read.path))).toBe(false);
    expect(data.reads.filter(read => read.path === `/api/quotations/${quotationId}`)).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(data.external).toEqual([]);
    expect(data.mutations).toEqual([]);
    expect(data.errors).toEqual([]);
  } finally { release(); }
});

test('catalog results do not wait for slow filter metadata', async ({ page, baseURL }) => {
  const data = await fixtureCatalog(page, baseURL!);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const heldPaths: string[] = [];
  await page.route('**/api/catalog/hierarchy**', async route => {
    heldPaths.push(new URL(route.request().url()).pathname);
    await pending;
    await route.fulfill({ json: { tree: [] } });
  });
  try {
    await page.goto('/catalog', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('family-performance-family')).toBeVisible();
    expect(heldPaths).toEqual(['/api/catalog/hierarchy']);
    expect(data.completed.some(read => read.path === '/api/catalog/hierarchy')).toBe(false);
    expect(data.external).toEqual([]);
    expect(data.errors).toEqual([]);
  } finally { release(); }
});
