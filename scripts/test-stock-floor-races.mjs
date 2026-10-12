import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual screen's hooks with deferred API promises. Browser floor
// switches abort fetch, so this also covers callbacks whose transport has
// already completed, including native/retained-screen interleavings.
const source = readFileSync(process.argv[2] || new URL('../app/(admin)/godown-stock.tsx', import.meta.url), 'utf8');
const instrumented = source.replace('  if (loading) return', '  return { load, data, newLot, poFinalMatches };\n  if (loading) return');
assert.notEqual(instrumented, source, 'The screen state observation point must exist');
const compiled = ts.transpileModule(instrumented, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const filterExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/filters.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: filterExports });

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = name => ({ lots: [{ id: 'new-lot', name, sku: 'SKU-1', available_qty: 1 }], brands: [], total_available_qty: 1 });

function screen(newStockId) {
  const hooks = [];
  const pendingEffects = [];
  const stocks = [];
  const matches = [];
  const errors = [];
  let index = 0, dirty = false, state, floor = 'first-floor';
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const slot = index++;
      if (!hooks[slot]) hooks[slot] = { value: initial };
      return [hooks[slot].value, value => {
        const next = typeof value === 'function' ? value(hooks[slot].value) : value;
        if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const slot = index++;
      return hooks[slot] ||= { current: initial };
    },
    useCallback(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps };
      return hooks[slot].value;
    },
    useMemo(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback(), deps };
      return hooks[slot].value;
    },
    useEffect(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) {
        const cleanup = hooks[slot]?.cleanup;
        hooks[slot] = { deps };
        pendingEffects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
      }
    },
  };
  const modules = {
    react,
    '@/src/utils/filters': filterExports,
    'react-native': { StyleSheet: { create: value => value } },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({ newStockId }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor }) },
    '@/src/hooks/use-permissions': { useActionAccess: (_resource, _action, allowed = true) => allowed },
    '@/src/state/auth': { useAuth: () => ({ staff: { role: 'owner' } }) },
    '@/src/design/responsive': { useBp: () => ({ isPhone: false, isDesktop: true }) },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} },
    '@/src/components/Toast': { toast: { error: message => errors.push(message) } },
    '@/src/api/godownStock': {
      getGodownStock: (_params, requestFloor) => { const pending = deferred(); stocks.push({ ...pending, floor: requestFloor }); return pending.promise; },
      getPoFinalMatches: id => { const pending = deferred(); matches.push({ ...pending, id }); return pending.promise; },
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, setTimeout, clearTimeout });
  const render = () => {
    index = 0; dirty = false;
    state = exports.default();
    while (pendingEffects.length) pendingEffects.shift()();
    return state;
  };
  return {
    stocks, matches, errors, render,
    get state() { return state; },
    switchFloor(value) { floor = value; render(); },
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
    async settle() {
      for (let pass = 0; pass < 8; pass++) { await Promise.resolve(); if (dirty) render(); }
    },
  };
}

test('a retained transfer callback cannot start an old-floor reload or invalidate the new floor request', async () => {
  const fixture = screen();
  fixture.render(); fixture.stocks[0].resolve(response('Sanitary stock')); await fixture.settle();
  const transferred = fixture.state.load;
  fixture.switchFloor('ground-floor');
  const completion = transferred();
  assert.equal(fixture.stocks.length, 2);
  await completion;
  assert.equal(fixture.stocks[1].floor, 'ground-floor');
  fixture.stocks[1].resolve(response('Ground stock')); await fixture.settle();
  assert.equal(fixture.state.data.lots[0].name, 'Ground stock');
});

test('a delayed inventory response cannot replace the current floor inventory', async () => {
  const fixture = screen(); fixture.render();
  fixture.switchFloor('ground-floor');
  fixture.stocks[1].resolve(response('Ground stock')); await fixture.settle();
  fixture.stocks[0].resolve(response('Stale sanitary stock')); await fixture.settle();
  assert.equal(fixture.state.data.lots[0].name, 'Ground stock');
});

for (const outcome of ['matches', 'error']) {
  test(`a delayed new-stock PO ${outcome} cannot reopen a previous floor dialog or show its error`, async () => {
    const fixture = screen('new-lot'); fixture.render();
    fixture.stocks[0].resolve(response('Sanitary stock')); await fixture.settle();
    assert.equal(fixture.matches.length, 1);
    fixture.switchFloor('ground-floor');
    assert.equal(fixture.matches.length, 1, 'Old inventory must not seed a lookup under the new floor');
    fixture.stocks[1].resolve({ ...response('Ground stock'), lots: [] }); await fixture.settle();
    if (outcome === 'error') fixture.matches[0].reject({ detail: 'Old floor error' });
    else fixture.matches[0].resolve({ matches: [{ purchase_item_id: 'old-item', customer_name: 'Old customer' }] });
    await fixture.settle();
    assert.equal(fixture.state.newLot, null);
    assert.equal(fixture.state.poFinalMatches.length, 0);
    assert.equal(fixture.errors.length, 0);
  });
}

test('a callback completed after unmount cannot issue a stock reload', async () => {
  const fixture = screen(); fixture.render();
  fixture.stocks[0].resolve(response('Sanitary stock')); await fixture.settle();
  const transferred = fixture.state.load;
  fixture.unmount(); const completion = transferred();
  assert.equal(fixture.stocks.length, 1);
  await completion;
});

test('current-floor PO matches still open the matching-order dialog', async () => {
  const fixture = screen('new-lot'); fixture.render();
  fixture.stocks[0].resolve(response('Sanitary stock')); await fixture.settle();
  fixture.matches[0].resolve({ matches: [{ purchase_item_id: 'current-item' }] }); await fixture.settle();
  assert.equal(fixture.state.newLot.name, 'Sanitary stock');
  assert.equal(fixture.state.poFinalMatches[0].purchase_item_id, 'current-item');
});

test('refreshing the same floor cancels the prior match lookup and checks the refreshed lot', async () => {
  const fixture = screen('new-lot'); fixture.render();
  fixture.stocks[0].resolve(response('Before refresh')); await fixture.settle();
  const reload = fixture.state.load();
  fixture.stocks[1].resolve(response('After refresh')); await reload; await fixture.settle();
  assert.equal(fixture.matches.length, 2);
  fixture.matches[0].resolve({ matches: [{ purchase_item_id: 'stale-item' }] }); await fixture.settle();
  assert.equal(fixture.state.newLot, null);
  fixture.matches[1].resolve({ matches: [{ purchase_item_id: 'current-item' }] }); await fixture.settle();
  assert.equal(fixture.state.newLot.name, 'After refresh');
  assert.equal(fixture.state.poFinalMatches[0].purchase_item_id, 'current-item');
});
