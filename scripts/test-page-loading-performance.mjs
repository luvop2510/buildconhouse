import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import './test-customer-edit-lifecycle.mjs';
import './test-customer-switcher-lifecycle.mjs';
import './test-kitchen-lazy-entry.mjs';
import './test-quotation-list-paging.mjs';

// Execute the production screen hooks, holding secondary responses indefinitely.
// A fake clock makes the initial-load/search distinction deterministic and tests
// callbacks whose network response has completed during a route/floor change.
const catalogExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/services/catalogService.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: catalogExports, require: () => ({}), URLSearchParams });

const specs = {
  payments: ['../app/(admin)/payments.tsx', '  const customerCollections =', 'orders, stats, loadingList, q, setQ'],
  walkin: ['../app/(admin)/walkins/[id].tsx', '  const updateStatus =', 'w, timeline, timelineLoading, timelineError, loadError, load'],
  tiles: ['../src/components/tiles/TilesProductPicker.tsx', '  return (\n    <Overlay', 'query, setQuery, results, total, loading, loadingMore, hasMore, loadMore'],
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
  let open = true;
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
    memo: component => component,
    useState(initial) {
      const slot = cursor++;
      hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, value => {
        const next = typeof value === 'function' ? value(hooks[slot].value) : value;
        if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; }
      }];
    },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useId() { return `test-${cursor++}`; },
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
    'react-native': { StyleSheet: { create: value => value }, Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 390 }) },
    './tilePresentation': { tilesPickerColumns: () => 1 },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({ id: routeId }) },
    '@/src/api/client': { api: { get } },
    '@/src/hooks/use-reduced-motion': { useReducedMotion: () => false },
    '@/src/utils/filters': { filterValues: value => !value || value === 'all' ? [] : value.split(',') },
    '@/src/api/walkins': { walkinsApi: { get: (id, options) => get(`/walkins/${id}`, options), timeline: (id, options) => get(`/walkins/${id}/timeline`, options), listAssignees: async () => [] } },
    '@/src/api/godownStock': { getCustomerStockTransfers: async () => ({ transfers: [] }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor }), useRequireFloorAccess: () => ready },
    '@/src/hooks/use-permissions': { useActionAccess: () => true, useModuleAccess: () => () => true },
    '@/src/state/auth': { useAuth: () => ({ staff: { role: 'owner' } }) },
    '@/src/constants/roles': { canManageDestructiveData: () => true },
    '@/src/design/responsive': { useBp: () => bp },
    '@/src/hooks/use-breakpoint': { useBreakpoint: () => bp },
    '@/src/theme/tokens': { colors: {}, spacing: {}, radius: {}, icon: {}, type: new Proxy({}, { get: () => ({}) }) },
    '@/src/services/catalogService': {
      CATALOG_PAGE_SIZE: catalogExports.CATALOG_PAGE_SIZE,
      catalogReferences: { facets: async () => ({}), brands: async () => [], categories: async () => [], hierarchy: async () => ({ tree: [] }) },
      fetchCatalogPage: (query, skip, limit, options) => get('catalog-page', { ...options, query, skip, limit }),
      mergeCatalogPage: catalogExports.mergeCatalogPage,
      catalogPageProgress: catalogExports.catalogPageProgress,
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require: id => modules[id] || {}, AbortController, URLSearchParams,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const render = (flushEffects = true) => {
    cursor = 0; dirty = false;
    state = kind === 'tiles' ? exports.TilesProductPicker({ open, onClose() {}, onPick() {} }) : exports.default();
    while (flushEffects && effects.length) effects.shift()();
    return state;
  };
  return {
    requests, render,
    get state() { return state; },
    setOpen(value) { open = value; render(); },
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
    assert.equal(fixture.requests.find(request => request.path === 'catalog-page').options.limit, 50);
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


test('catalog overlapping pages advance the server cursor and empty pages stop fetching', async () => {
  const fixture = screen('catalog'); fixture.render(); await fixture.settle();
  const initial = fixture.requests.filter(request => request.path === 'catalog-page');
  for (const request of initial) request.resolve({ total: 5, items: [{ family_key: 'a' }, { family_key: 'b' }] });
  await fixture.settle();
  const loading = fixture.state.loadMore();
  const second = fixture.requests.at(-1);
  assert.equal(second.options.skip, 2);
  second.resolve({ total: 5, items: [{ family_key: 'b' }, { family_key: 'c' }] });
  await loading; await fixture.settle();
  assert.equal(fixture.state.families.length, 3, 'Overlapping server row is shown only once');
  const pending = fixture.state.loadMore();
  const third = fixture.requests.at(-1);
  assert.equal(third.options.skip, 4, 'Advance by consumed server rows, including overlap');
  third.resolve({ total: 5, items: [] });
  await pending; await fixture.settle();
  assert.equal(fixture.state.hasMore, false);
  const before = fixture.requests.length;
  await fixture.state.loadMore(); await fixture.settle();
  assert.equal(fixture.requests.length, before, 'Repeated end-reached cannot refetch the empty page');
});

test('catalog delayed previous-floor page cannot change the new floor cursor', async () => {
  const fixture = screen('catalog'); fixture.render(); await fixture.settle();
  const stale = fixture.requests.filter(request => request.path === 'catalog-page');
  fixture.changeFloor('ground-floor'); await fixture.settle();
  const current = fixture.requests.filter(request => request.path === 'catalog-page' && !stale.includes(request));
  current.at(-1).resolve({ total: 4, items: [{ family_key: 'ground' }] });
  await fixture.settle();
  for (const request of stale) request.resolve({ total: 100, items: Array.from({ length: 60 }, (_, i) => ({ family_key: `stale-${i}` })) });
  await fixture.settle();
  const pending = fixture.state.loadMore();
  const next = fixture.requests.at(-1);
  assert.equal(next.options.skip, 1);
  assert.equal(next.options.floorId, 'ground-floor');
  next.resolve({ total: 4, items: [] }); await pending; await fixture.settle();
});

test('catalog ignores a retained previous-floor pagination callback', async () => {
  const fixture = screen('catalog'); fixture.render(); await fixture.settle();
  const initial = fixture.requests.filter(request => request.path === 'catalog-page');
  for (const request of initial) request.resolve({ total: 5, items: [{ family_key: 'sanitary' }] });
  await fixture.settle();
  const previous = fixture.state.loadMore;
  fixture.changeFloor('ground-floor'); await fixture.settle();
  const count = fixture.requests.length;
  void previous(); await fixture.settle();
  assert.equal(fixture.requests.length, count, 'A deferred old scroll event must not fetch or publish another floor');
});


test('catalog pagination callbacks do not start work after unmount', async () => {
  const fixture = screen('catalog'); fixture.render(); await fixture.settle();
  for (const request of fixture.requests.filter(request => request.path === 'catalog-page')) request.resolve({ total: 10, items: [{ family_key: 'loaded' }] });
  await fixture.settle();
  const previous = fixture.state.loadMore;
  fixture.unmount();
  const count = fixture.requests.length;
  await previous(); await fixture.settle();
  assert.equal(fixture.requests.length, count);
});


test('Ground Floor picker deduplicates simultaneous scroll reads and stops after an empty page', async () => {
  const fixture = screen('tiles'); fixture.render(); await fixture.settle();
  fixture.requests[0].resolve({ total: 5, items: [{ id: 'a' }, { id: 'b' }] }); await fixture.settle();
  fixture.state.loadMore(); fixture.state.loadMore();
  assert.equal(fixture.requests.length, 2, 'Scroll and end-reached share one pending page');
  fixture.requests[1].resolve({ total: 5, items: [{ id: 'b' }, { id: 'c' }] }); await fixture.settle();
  assert.equal(fixture.state.results.length, 3);
  fixture.state.loadMore();
  assert.equal(fixture.requests[2].options.skip, 4, 'Ground Floor consumes overlapping server rows');
  fixture.requests[2].resolve({ total: 5, items: [] }); await fixture.settle();
  assert.equal(fixture.state.hasMore, false);
  fixture.state.loadMore(); assert.equal(fixture.requests.length, 3);
});

test('Ground Floor typing immediately revokes earlier results during the debounce', async () => {
  const fixture = screen('tiles'); fixture.render(); await fixture.settle();
  fixture.state.setQuery('current'); fixture.render(); await fixture.settle();
  fixture.requests[0].resolve({ total: 1, items: [{ id: 'stale' }] }); await fixture.settle();
  assert.equal(fixture.state.results.length, 0);
  fixture.runTimers(180); await fixture.settle();
  fixture.requests[1].resolve({ total: 1, items: [{ id: 'current' }] }); await fixture.settle();
  assert.equal(fixture.state.results[0].id, 'current');
});

test('Ground Floor closed picker rejects responses and retained scroll callbacks', async () => {
  const fixture = screen('tiles'); fixture.render(); await fixture.settle();
  fixture.requests[0].resolve({ total: 4, items: [{ id: 'visible' }] }); await fixture.settle();
  const callback = fixture.state.loadMore;
  callback(); const pending = fixture.requests[1];
  fixture.setOpen(false); await fixture.settle();
  pending.resolve({ total: 4, items: [{ id: 'closed' }] }); await fixture.settle();
  assert.equal(fixture.state.results.length, 1);
  callback(); assert.equal(fixture.requests.length, 2);
});


test('catalog response between a changed render and passive effects cannot publish obsolete data', async () => {
  const fixture = screen('catalog'); fixture.render(); await fixture.settle();
  const stale = fixture.requests.filter(request => request.path === 'catalog-page');
  fixture.state.setQ('changed'); fixture.render(false);
  for (const request of stale) request.resolve({ total: 1, items: [{ family_key: 'obsolete' }] });
  await fixture.settle();
  assert.equal(fixture.state.families, null);
  fixture.render(); await fixture.settle();
  fixture.runTimers(250); await fixture.settle();
  const current = fixture.requests.at(-1);
  current.resolve({ total: 1, items: [{ family_key: 'current' }] }); await fixture.settle();
  assert.equal(fixture.state.families[0].family_key, 'current');
});


test('walk-in profile renders while optional timeline is held and recovers from timeline failure', async () => {
  const fixture = screen('walkin'); fixture.render(); await fixture.settle();
  fixture.requests.find(request => request.path === '/walkins/fixture').resolve({ id: 'fixture', customer_name: 'Primary walk-in' });
  await fixture.settle();
  assert.equal(fixture.state.w.customer_name, 'Primary walk-in');
  assert.equal(fixture.state.timelineLoading, true);
  fixture.requests.find(request => request.path.endsWith('/timeline')).reject({ detail: 'History unavailable' });
  await fixture.settle();
  assert.equal(fixture.state.w.customer_name, 'Primary walk-in');
  assert.equal(fixture.state.loadError, null);
  assert.equal(fixture.state.timelineError, true);
  assert.equal(fixture.state.timelineLoading, false);
});

test('walk-in timeline and primary responses cannot overwrite another route', async () => {
  const fixture = screen('walkin'); fixture.render(); await fixture.settle();
  const old = [...fixture.requests];
  fixture.changeRoute('current'); await fixture.settle();
  fixture.requests.find(request => request.path === '/walkins/current').resolve({ id: 'current' });
  fixture.requests.find(request => request.path === '/walkins/current/timeline').resolve([{ id: 'current-event' }]);
  await fixture.settle();
  old.find(request => request.path.endsWith('/timeline')).resolve([{ id: 'old-event' }]);
  old.find(request => !request.path.endsWith('/timeline')).reject({ detail: 'Old error' });
  await fixture.settle();
  assert.equal(fixture.state.w.id, 'current');
  assert.equal(fixture.state.timeline[0].id, 'current-event');
  assert.equal(fixture.state.loadError, null);
});

for (const width of ['phone', 'tablet', 'desktop']) {
  test(`payments starts its list immediately while optional stats wait on ${width}`, async () => {
    const fixture = screen('payments', width); fixture.render(); await fixture.settle();
    const list = fixture.requests.find(request => request.path === '/payments/orders');
    assert.ok(list, 'Initial list must start without a search debounce');
    list.resolve([{ id: 'order-1', outstanding: 10 }]); await fixture.settle();
    assert.equal(fixture.state.orders[0].id, 'order-1');
    assert.equal(fixture.state.loadingList, false);
    assert.equal(fixture.state.stats, null, 'Statistics remain independent');
  });
}

test('payments keeps typed search debounced and clearing/floor changes immediate', async () => {
  const fixture = screen('payments'); fixture.render(); await fixture.settle();
  const old = fixture.requests.find(request => request.path === '/payments/orders');
  fixture.state.setQ('new'); fixture.render(); await fixture.settle();
  assert.equal(fixture.requests.filter(request => request.path.startsWith('/payments/orders')).length, 1);
  fixture.runTimers(220); await fixture.settle();
  const search = fixture.requests.at(-1);
  assert.equal(search.path, '/payments/orders?q=new');
  fixture.state.setQ(''); fixture.render(); await fixture.settle();
  const cleared = fixture.requests.at(-1);
  assert.equal(cleared.path, '/payments/orders');
  fixture.changeFloor('ground-floor'); await fixture.settle();
  const current = fixture.requests.at(-1);
  assert.equal(current.path, '/payments/orders');
  current.resolve([{ id: 'current-floor', outstanding: 10 }]); await fixture.settle();
  for (const request of [old, search, cleared]) request.resolve([{ id: 'obsolete', outstanding: 20 }]);
  await fixture.settle();
  assert.equal(fixture.state.orders[0].id, 'current-floor');
});
