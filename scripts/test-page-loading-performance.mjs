import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production screen hooks, holding secondary responses indefinitely.
// A fake clock makes the initial-load/search distinction deterministic and tests
// callbacks whose network response has completed during a route/floor change.
const specs = {
  customer: ['../app/(admin)/customers/[id].tsx', '  const createWalkInFollowup =', 'customer, quotations, purchases, timeline, loadError, relatedErrors, relatedLoading, loadCore'],
  quotation: ['../app/(admin)/quotations/[id]/index.tsx', '  const openPdf =', 'q, breakdown, timeline, linkedPos, loading, loadError, relatedError, relatedLoading, breakdownLoading, load'],
  catalog: ['../app/(admin)/catalog/index.tsx', '  const brandById:', 'q, searchQuery, setQ, setMode, setBrandId, families, products, total, hasMore, loadMore'],
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function screen(kind, width = 'desktop') {
  const [file, marker, observation] = specs[kind];
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.ok(source.includes(marker), `Observation point exists in ${file}`);
  const compiled = ts.transpileModule(source.replace(marker, `  return { ${observation} };\n${marker}`), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const hooks = [], effects = [], requests = [], timers = new Map();
  let cursor = 0, dirty = false, state, routeId = 'fixture', floor = 'first-floor', ready = true, mounted = true, nextTimer = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const effect = (callback, deps) => {
    const slot = cursor++;
    if (!same(hooks[slot]?.deps, deps)) {
      const cleanup = hooks[slot]?.cleanup;
      hooks[slot] = { deps };
      effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
    }
  };
  const react = {
    useState(initial) {
      const slot = cursor++;
      hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, value => {
        const next = typeof value === 'function' ? value(hooks[slot].value) : value;
        if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; }
      }];
    },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useMemo(callback, deps) {
      const slot = cursor++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback(), deps };
      return hooks[slot].value;
    },
    useCallback(callback, deps) {
      const slot = cursor++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps };
      return hooks[slot].value;
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
  const get = (path, options) => {
    const pending = deferred();
    requests.push({ path, options, ...pending });
    return pending.promise;
  };
  const bp = { isPhone: width === 'phone', isDesktop: width === 'desktop', productCols: width === 'phone' ? 2 : 5 };
  const modules = {
    react,
    'react-native': { StyleSheet: { create: value => value }, Platform: { OS: 'web' } },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({ id: routeId }) },
    '@/src/api/client': { api: { get } },
    '@/src/api/godownStock': { getCustomerStockTransfers: async () => ({ transfers: [] }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor }), useRequireFloorAccess: () => ready },
    '@/src/hooks/use-permissions': { useActionAccess: () => true },
    '@/src/state/auth': { useAuth: () => ({ staff: { role: 'owner' } }) },
    '@/src/constants/roles': { canManageDestructiveData: () => true },
    '@/src/design/responsive': { useBp: () => bp },
    '@/src/hooks/use-breakpoint': { useBreakpoint: () => bp },
    '@/src/theme/tokens': { colors: {}, spacing: {}, radius: {}, icon: {}, type: new Proxy({}, { get: () => ({}) }) },
    '@/src/services/catalogService': {
      catalogReferences: { brands: async () => [], categories: async () => [], hierarchy: async () => ({ tree: [] }) },
      fetchCatalogPage: (query, skip, limit, options) => get('catalog-page', { ...options, query, skip, limit }),
      mergeCatalogPage: (current, incoming) => [...current, ...incoming],
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require: id => modules[id] || {}, AbortController, URLSearchParams,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const render = () => {
    cursor = 0; dirty = false;
    state = exports.default();
    while (effects.length) effects.shift()();
    return state;
  };
  return {
    requests, render,
    get state() { return state; },
    changeRoute(value) { routeId = value; render(); },
    changeFloor(value) { floor = value; render(); },
    setReady(value) { ready = value; render(); },
    unmount() { mounted = false; for (const hook of hooks) hook.cleanup?.(); },
    runTimers(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    },
    async settle() {
      for (let turn = 0; turn < 20; turn++) { await Promise.resolve(); if (dirty && mounted) render(); }
    },
  };
}

for (const width of ['phone', 'tablet', 'desktop']) {
  test(`customer profile renders while related requests are held on ${width}`, async () => {
    const fixture = screen('customer', width); fixture.render(); await fixture.settle();
    fixture.requests.find(request => request.path.startsWith('/customers/')).resolve({ id: 'fixture', name: 'Primary customer' });
    await fixture.settle();
    assert.equal(fixture.state.customer.name, 'Primary customer');
    assert.equal(fixture.state.relatedLoading, true);
    assert.ok(fixture.requests.some(request => request.path === '/quotations?customer_id=fixture'));
    for (const request of fixture.requests) assert.equal(request.options.floorId, 'first-floor');
  });

  test(`quotation summary renders while history and prices are held on ${width}`, async () => {
    const fixture = screen('quotation', width); fixture.render();
    fixture.requests.find(request => request.path.endsWith('?with_completion=true')).resolve({ id: 'fixture', number: 'Q-PRIMARY' });
    await fixture.settle();
    assert.equal(fixture.state.q.number, 'Q-PRIMARY');
    assert.equal(fixture.state.loading, false);
    assert.equal(fixture.state.breakdownLoading, true, 'No approximate line prices while authoritative prices are loading');
    assert.equal(fixture.state.relatedLoading, true);
  });

  test(`catalog starts without running a debounce timer on ${width}`, async () => {
    const fixture = screen('catalog', width); fixture.render(); await fixture.settle();
    assert.ok(fixture.requests.some(request => request.path === 'catalog-page'));
    assert.equal(fixture.requests.find(request => request.path === 'catalog-page').options.limit, 60);
  });
}

for (const kind of ['customer', 'quotation']) {
  test(`${kind} rejects delayed primary, secondary and failures from the previous route`, async () => {
    const fixture = screen(kind); fixture.render(); await fixture.settle();
    const stale = [...fixture.requests];
    fixture.changeRoute('current'); await fixture.settle();
    const current = fixture.requests.filter(request => !stale.includes(request));
    current.find(request => request.path.endsWith('?with_completion=true')).resolve({ id: 'current', name: 'Current', number: 'CURRENT' });
    await fixture.settle();
    for (const request of stale) {
      if (request.path.startsWith('/activity/')) request.reject({ detail: 'Old failure' });
      else request.resolve({ id: 'stale', name: 'Stale', number: 'STALE' });
    }
    await fixture.settle();
    assert.equal((fixture.state.customer || fixture.state.q).id, 'current');
    assert.equal(fixture.state.relatedErrors ?? fixture.state.relatedError, false);
    assert.equal(fixture.state.loadError, null);
  });

  test(`${kind} ignores callbacks and delayed responses after unmount`, async () => {
    const fixture = screen(kind); fixture.render(); await fixture.settle();
    const reload = fixture.state.loadCore || fixture.state.load;
    fixture.unmount();
    const count = fixture.requests.length;
    await reload();
    for (const request of fixture.requests) request.reject({ detail: 'Unloaded' });
    await fixture.settle();
    assert.equal(fixture.state.loadError, null);
    assert.equal(fixture.requests.length, count);
  });

  test(`${kind} ignores a retained reload callback from the previous route`, async () => {
    const fixture = screen(kind); fixture.render(); await fixture.settle();
    const reload = fixture.state.loadCore || fixture.state.load;
    fixture.changeRoute('current'); await fixture.settle();
    const count = fixture.requests.length;
    await reload();
    assert.equal(fixture.requests.length, count);
  });
}

test('customer delayed floor response cannot restore a previous workspace profile', async () => {
  const fixture = screen('customer'); fixture.render(); await fixture.settle();
  const old = [...fixture.requests];
  fixture.changeFloor('ground-floor'); await fixture.settle();
  const primary = fixture.requests.filter(request => !old.includes(request)).find(request => request.path.startsWith('/customers/'));
  primary.resolve({ id: 'fixture', name: 'Ground profile' }); await fixture.settle();
  old.find(request => request.path.startsWith('/customers/')).resolve({ id: 'fixture', name: 'Old sanitary profile' }); await fixture.settle();
  assert.equal(fixture.state.customer.name, 'Ground profile');
  assert.equal(primary.options.floorId, 'ground-floor');
});

test('quotation waits for authorized document floor before making business reads', async () => {
  const fixture = screen('quotation'); fixture.setReady(false); await fixture.settle();
  assert.equal(fixture.requests.length, 0);
  fixture.setReady(true); await fixture.settle();
  assert.equal(fixture.requests.length, 4);
});

test('catalog debounces typing but immediately refetches when cleared during pending startup', async () => {
  const fixture = screen('catalog'); fixture.render(); await fixture.settle();
  const old = fixture.requests.filter(request => request.path === 'catalog-page');
  fixture.state.setQ('tap'); fixture.render(); await fixture.settle();
  assert.equal(fixture.requests.filter(request => request.path === 'catalog-page').length, old.length);
  fixture.state.setQ(''); fixture.render(); await fixture.settle();
  const current = fixture.requests.filter(request => request.path === 'catalog-page' && !old.includes(request));
  assert.ok(current.length > 0, 'Clearing a not-yet-committed search starts another valid initial load');
  for (const request of old) request.resolve({ total: 1, items: [{ family_key: 'stale' }] });
  await fixture.settle(); assert.equal(fixture.state.total, null);
  current.at(-1).resolve({ total: 1, items: [{ family_key: 'current' }] }); await fixture.settle();
  assert.equal(fixture.state.families[0].family_key, 'current');
});

test('catalog does not fetch a previous search when a categorical filter changes during typing', async () => {
  const fixture = screen('catalog'); fixture.render(); await fixture.settle();
  const before = fixture.requests.length;
  fixture.state.setQ('tap'); fixture.render(); await fixture.settle();
  fixture.state.setBrandId('brand-one'); fixture.render(); await fixture.settle();
  assert.equal(fixture.requests.length, before);
  fixture.runTimers(250); await fixture.settle();
  const request = fixture.requests.at(-1);
  assert.equal(request.options.query.q, 'tap');
  assert.deepEqual([...request.options.query.brandIds], ['brand-one']);
});

test('catalog mode changes fetch immediately and old family pages cannot replace product pages', async () => {
  const fixture = screen('catalog'); fixture.render(); await fixture.settle();
  const old = fixture.requests.filter(request => request.path === 'catalog-page');
  fixture.state.setMode('products'); fixture.render(); await fixture.settle();
  const current = fixture.requests.at(-1);
  assert.equal(current.options.query.mode, 'products');
  current.resolve({ total: 1, items: [{ id: 'product' }] }); await fixture.settle();
  for (const request of old) request.resolve({ total: 1, items: [{ family_key: 'stale' }] });
  await fixture.settle();
  assert.equal(fixture.state.products[0].id, 'product');
  assert.equal(fixture.state.families, null);
});
