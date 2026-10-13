import { expect, test, type Page } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import { mockSession } from './audit-fixtures';

const LATENCY_MS = 200;
const performanceFixtures = new WeakMap<Page, Record<string, unknown>>();

test.afterEach(async ({ page }, info) => {
  const data = performanceFixtures.get(page);
  if (!data) return;
  const tasks = await page.evaluate(() => ({ supported: PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false, durations: (window as any).__performanceLongTasks })).catch(() => null);
  await info.attach('request-and-runtime-evidence', { body: JSON.stringify({ device: info.project.name, fixtureLatencyMs: LATENCY_MS, ...data, tasks }, null, 2), contentType: 'application/json' });
});
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

async function fixtureCatalog(page: Page, baseURL: string, overrides: Record<string, unknown> = {}) {
  const origin = new URL(baseURL).origin;
  const started = performance.now();
  const reads: { path: string; query: string; atMs: number; floor: string | undefined }[] = [];
  const completed: { path: string; atMs: number }[] = [];
  const external: string[] = [];
  const mutations: string[] = [];
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: { path: string; error: string | null }[] = [];
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
  page.on('crash', () => errors.push('Browser page crashed'));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText || null }));
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
    ...overrides,
  };
  await page.route('**/api/**', async route => {
    // Delaying every request makes redundant requests and serial waterfalls
    // observable without relying on production database or network state.
    await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
    const path = new URL(route.request().url()).pathname;
    if (Object.hasOwn(replies, path)) return route.fulfill({ json: replies[path] });
    return route.fallback();
  });
  const data = { started, reads, completed, external, mutations, errors, consoleErrors, failedRequests };
  performanceFixtures.set(page, data);
  return data;
}

test('team assign renders a full activity page and switches floors promptly', async ({ page, baseURL }, info) => {
  const workers = Array.from({ length: 3 }, (_, worker) => ({
    user_id: `performance-worker-${worker}`, user_name: `Worker ${worker + 1}`,
    assigned_leads: 100, contacts_made: 250, calls_made: 200, completed_leads: 20,
    leads: Array.from({ length: worker === 0 ? 18 : 16 }, (_, lead) => ({
      id: `performance-lead-${worker}-${lead}`, customer_name: `Lead ${worker}-${lead}`,
      floor_id: 'first-floor', status: 'open', contact_attempts: 3, call_attempts: 2,
      latest_response: 'Interested in the selected floors', latest_update: 'Call back arranged',
      activity: Array.from({ length: 5 }, (_, event) => ({ id: `${lead}-${event}`, action: 'call', description: 'Called lead', response: 'Requested showroom visit', created_at: '2026-10-13T10:00:00Z' })),
    })),
  }));
  const data = await fixtureCatalog(page, baseURL!, {
    '/api/followups/team-assign': { workers, has_more: true, page: 1, page_size: 50 },
  });
  const start = performance.now();
  await page.goto('/team-assign', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('team-worker-performance-worker-0')).toBeVisible();
  const readyMs = performance.now() - start;
  expect(readyMs).toBeLessThan(2500);
  const interaction = performance.now();
  await page.getByTestId('team-lead-performance-lead-0-0').click();
  await expect(page.getByText('Called lead · Requested showroom visit').first()).toBeVisible();
  const expandMs = performance.now() - interaction;
  expect(expandMs).toBeLessThan(750);
  const floorStart = performance.now();
  await page.getByRole('button', { name: 'Tiles', exact: true }).click();
  await expect.poll(() => data.reads.filter(read => read.path === '/api/followups/team-assign').length).toBe(2);
  await expect.poll(() => data.completed.filter(read => read.path === '/api/followups/team-assign').length).toBe(2);
  await expect(page.getByTestId('team-worker-performance-worker-0')).toBeVisible();
  const floorMs = performance.now() - floorStart;
  expect(floorMs).toBeLessThan(1500);
  expect(new URLSearchParams(data.reads.filter(read => read.path === '/api/followups/team-assign')[1].query).get('floor_ids')).toBe('ground-floor');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(data.errors).toEqual([]);
  expect(data.consoleErrors).toEqual([]);
  expect(data.external).toEqual([]);
  expect(data.mutations).toEqual([]);
  await info.attach('team-assignment-performance', { body: JSON.stringify({ device: info.project.name, readyMs, expandMs, floorMs, leads: 50, reads: data.reads }, null, 2), contentType: 'application/json' });
});

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
    device: info.project.name, browserVersion: page.context().browser()?.version(), fixtureLatencyMs: LATENCY_MS, readyMs,
    requestAfterFloorMs, requestAfterReferencesMs, reads: data.reads,
    longTasksMs: await page.evaluate(() => (window as any).__performanceLongTasks),
    consoleErrors: data.consoleErrors, failedRequests: data.failedRequests,
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
  for (const path of ['/api/auth/me', '/api/settings/floor-access', '/api/brands', '/api/categories', '/api/catalog/hierarchy', '/api/catalog/facets']) {
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
    expect(readyMs).toBeLessThan(2500);
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
    expect(readyMs).toBeLessThan(2500);
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

test('repeated navigation and viewport rotation remain usable on a slower CPU', async ({ page, browserName, baseURL }, info) => {
  const data = await fixtureCatalog(page, baseURL!);
  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const timings: number[] = [];
  try {
    await page.goto('/customers');
    await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
    for (const viewport of [{ width: 360, height: 800 }, { width: 800, height: 360 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      const started = performance.now();
      const catalogLink = page.getByTestId(viewport.width < 768 ? 'bottom-nav-catalog' : 'nav-catalog');
      await catalogLink.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('family-performance-family')).toBeVisible();
      timings.push(performance.now() - started);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.goBack();
      await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
    }
    expect(Math.max(...timings)).toBeLessThan(2500);
    expect(data.errors).toEqual([]);
    expect(data.external).toEqual([]);
    expect(data.mutations).toEqual([]);
    await info.attach('navigation-rotation-timings', { body: JSON.stringify({ cpuThrottle: cdp ? 4 : 'unavailable on this engine', fixtureLatencyMs: LATENCY_MS, timings, reads: data.reads, consoleErrors: data.consoleErrors, failedRequests: data.failedRequests }, null, 2), contentType: 'application/json' });
  } finally {
    if (cdp) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await cdp.detach(); }
  }
});

test('a delayed obsolete search cannot replace newer catalog results', async ({ page, baseURL }) => {
  const data = await fixtureCatalog(page, baseURL!);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/products/families?**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'obsolete') await pending;
    const id = query || 'initial';
    return route.fulfill({ json: { total: 1, items: [{ ...family, family_key: id, family_name: `${id} basin` }] } });
  });
  try {
    await page.goto('/catalog');
    await expect(page.getByTestId('family-initial')).toBeVisible();
    const search = page.getByRole('textbox', { name: 'Search catalog', exact: true });
    const oldStarted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/products/families' && new URL(request.url()).searchParams.get('q') === 'obsolete');
    await search.fill('obsolete');
    await oldStarted;
    await search.fill('current');
    await expect(page.getByTestId('family-current')).toBeVisible();
    const oldFinished = page.waitForResponse(response => new URL(response.url()).pathname === '/api/products/families' && new URL(response.url()).searchParams.get('q') === 'obsolete');
    release();
    await oldFinished;
    await expect(page.getByTestId('family-current')).toBeVisible();
    await expect(page.getByTestId('family-obsolete')).toHaveCount(0);
    expect(data.errors).toEqual([]);
    expect(data.external).toEqual([]);
  } finally { release(); }
});

test('repeated catalog visits retain one signed-in session and reuse reference data', async ({ page, baseURL }, info) => {
  const data = await fixtureCatalog(page, baseURL!);
  await page.goto('/customers');
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
  const timings: number[] = [];
  for (let visit = 0; visit < 12; visit++) {
    const started = performance.now();
    const catalogLink = page.getByTestId(page.viewportSize()!.width < 768 ? 'bottom-nav-catalog' : 'nav-catalog');
    await catalogLink.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('family-performance-family')).toBeVisible();
    timings.push(performance.now() - started);
    await page.goBack();
    await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
  }
  for (const path of ['/api/auth/me', '/api/settings/floor-access', '/api/brands', '/api/categories', '/api/catalog/hierarchy', '/api/catalog/facets']) {
    expect(data.reads.filter(read => read.path === path), path).toHaveLength(1);
  }
  expect(data.errors).toEqual([]);
  expect(data.external).toEqual([]);
  expect(data.mutations).toEqual([]);
  expect(timings[0]).toBeLessThan(2500);
  expect(Math.max(...timings.slice(1))).toBeLessThan(750);
  await info.attach('repeated-session-navigation', { body: JSON.stringify({ visits: 12, device: info.project.name, fixtureLatencyMs: LATENCY_MS, timings, reads: data.reads, consoleErrors: data.consoleErrors, failedRequests: data.failedRequests }, null, 2), contentType: 'application/json' });
});

// A one-card fixture cannot detect expensive grid/variant rendering. Return a
// full bounded page at the actual catalog scale, with ten finishes per family.
const realisticFamilies = Array.from({ length: 60 }, (_, index) => ({
  ...family, family_key: `scale-${index}`, family_name: `Scale basin ${index}`,
  sample_product_id: `scale-${index}-0`, product_count: 10,
  variants: Array.from({ length: 10 }, (_, finish) => ({
    ...product, id: `scale-${index}-${finish}`, sku: `SCALE-${index}-${finish}`,
    name: `Scale basin ${index}`, finish: `Finish ${finish}`, images: [],
  })),
}));
const realisticReplies = {
  '/api/products/families': { total: 6500, items: realisticFamilies },
  '/api/quotations/recent': [],
  '/api/quotations': [],
};

async function assertHealthyInteraction(page: Page, data: Awaited<ReturnType<typeof fixtureCatalog>>) {
  // Long Task API is supported in Chromium; Safari still enforces the actual
  // interaction deadline and crash/error guard. Never treat no support as zero.
  const tasks = await page.evaluate(() => ({
    supported: PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false,
    durations: (window as any).__performanceLongTasks as number[],
  }));
  if (tasks.supported) {
    expect(Math.max(0, ...tasks.durations), 'one task must not freeze input for half a second').toBeLessThan(500);
    expect(tasks.durations.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0), 'total blocking CPU in the scenario').toBeLessThan(1500);
  }
  expect(data.errors).toEqual([]);
  expect(data.consoleErrors).toEqual([]);
  expect(data.external).toEqual([]);
  expect(data.mutations).toEqual([]);
  expect(data.failedRequests.filter(request => !/abort|cancel/i.test(request.error || ''))).toEqual([]);
  return tasks;
}

test('full catalog page stays bounded and search responds under CPU pressure', async ({ page, browserName, baseURL }, info) => {
  const data = await fixtureCatalog(page, baseURL!, realisticReplies);
  const searchTimings: number[] = [];
  await page.route('**/api/products/families?**', async route => {
    const query = new URL(route.request().url()).searchParams;
    if (!query.get('q')) return route.fallback();
    await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
    return route.fulfill({ json: { total: 1, items: [{ ...realisticFamilies[0], family_key: query.get('q') }] } });
  });
  const started = performance.now();
  await page.goto('/catalog', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('family-scale-0')).toBeVisible();
  const readyMs = performance.now() - started;
  expect(readyMs).toBeLessThan(2500);
  const initial = data.reads.filter(read => read.path === '/api/products/families');
  expect(initial).toHaveLength(1);
  expect(new URLSearchParams(initial[0].query).get('limit')).toBe('60');
  expect(new URLSearchParams(initial[0].query).get('skip')).toBe('0');
  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    const search = page.getByRole('textbox', { name: 'Search catalog', exact: true });
    for (const term of ['pressure-one', 'pressure-two', 'pressure-three']) {
      const interactionStarted = performance.now();
      await search.fill(term);
      await expect(page.getByTestId(`family-${term}`)).toBeVisible();
      searchTimings.push(performance.now() - interactionStarted);
    }
    expect(Math.max(...searchTimings)).toBeLessThan(1500);
    expect(data.reads.filter(read => read.path === '/api/products/families')).toHaveLength(4);
    const tasks = await assertHealthyInteraction(page, data);
    await info.attach('realistic-catalog-performance', { body: JSON.stringify({ readyMs, searchTimings, cpuThrottle: cdp ? 4 : null, fixtureLatencyMs: LATENCY_MS, familyTotal: 6500, pageSize: 60, variantsPerFamily: 10, tasks, reads: data.reads }, null, 2), contentType: 'application/json' });
  } finally {
    if (cdp) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await cdp.detach(); }
  }
});

test('quotation builder renders a full variant page and adds a line promptly', async ({ page, baseURL }, info) => {
  const data = await fixtureCatalog(page, baseURL!, realisticReplies);
  const started = performance.now();
  await page.goto('/quotations/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  const addFirst = page.getByTestId('mobile-add-first');
  if (await addFirst.isVisible()) await addFirst.click();
  const picker = page.getByRole('dialog', { name: 'Add products', exact: true });
  const controls = await picker.isVisible() ? picker : page;
  await expect(controls.getByTestId('product-card-SCALE-0-0')).toBeVisible();
  const readyMs = performance.now() - started;
  expect(readyMs).toBeLessThan(2500);
  const initial = data.reads.filter(read => read.path === '/api/products/families');
  expect(initial).toHaveLength(1);
  expect(new URLSearchParams(initial[0].query).get('limit')).toBe('60');
  const addStarted = performance.now();
  await controls.getByTestId('add-SCALE-0-0').click();
  // Quantity badge proves the real line state has changed, without saving any
  // quotation or making a backend mutation.
  await expect(controls.getByTestId('product-card-SCALE-0-0').getByText('1 in this room', { exact: true })).toBeVisible();
  const addMs = performance.now() - addStarted;
  expect(addMs).toBeLessThan(750);
  const tasks = await assertHealthyInteraction(page, data);
  await info.attach('realistic-builder-performance', { body: JSON.stringify({ readyMs, addMs, fixtureLatencyMs: LATENCY_MS, tasks, reads: data.reads }, null, 2), contentType: 'application/json' });
});

test('Ground Floor cold navigation starts both document reads in parallel', async ({ page, baseURL }, info) => {
  const data = await fixtureCatalog(page, baseURL!, realisticReplies);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor', JSON.stringify('ground-floor')));
  const started = performance.now();
  await page.goto('/tiles', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('No quotations yet', { exact: true })).toBeVisible();
  const readyMs = performance.now() - started;
  expect(readyMs).toBeLessThan(2500);
  const documentReads = data.reads.filter(read => read.path === '/api/quotations');
  expect(documentReads).toHaveLength(2);
  expect(documentReads.every(read => read.floor === 'ground-floor')).toBe(true);
  expect(new Set(documentReads.map(read => new URLSearchParams(read.query).get('doc_type')))).toEqual(new Set(['tiles_selection', 'tiles_quotation']));
  expect(Math.abs(documentReads[0].atMs - documentReads[1].atMs)).toBeLessThan(100);
  const tasks = await assertHealthyInteraction(page, data);
  await info.attach('ground-floor-performance', { body: JSON.stringify({ readyMs, fixtureLatencyMs: LATENCY_MS, tasks, reads: data.reads }, null, 2), contentType: 'application/json' });
});
