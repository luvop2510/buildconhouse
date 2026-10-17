import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/purchases.tsx', import.meta.url), 'utf8');
const instrumented = source.replace('  if (!isDesktop) {', '  return { loadItems, loadFacets, loadCustomers, items, customers, brands, loading, itemsError };\n  if (!isDesktop) {');
assert.notEqual(instrumented, source);
const compile = text => ts.transpileModule(text, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const filters = {};
vm.runInNewContext(compile(readFileSync(new URL('../src/utils/filters.ts', import.meta.url), 'utf8')), { exports: filters });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = name => ({ items: [{ item_id: name, name }], total: 1, next_skip: null,
  summaries: { blocked_count: 0, sla_days: 7, stage_counts: {} } });

function screen() {
  const hooks = [], effects = [], pages = [], customerReads = [], facets = [];
  let index = 0, dirty = false, state, floor = 'first-floor';
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    memo: value => value,
    useState(initial) { const slot = index++; if (!hooks[slot]) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, next => { const value = typeof next === 'function' ? next(hooks[slot].value) : next; if (!Object.is(value, hooks[slot].value)) { hooks[slot].value = value; dirty = true; } }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(value, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value, deps }; return hooks[slot].value; },
    useMemo(fn, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: fn(), deps }; return hooks[slot].value; },
    useEffect(fn, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = fn(); }); } },
  };
  const modules = {
    react, '@/src/utils/filters': filters,
    'react-native': { StyleSheet: { create: value => value, hairlineWidth: 1 }, Platform: { OS: 'web' } },
    'expo-router': { useRouter: () => ({}) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
    '@/src/design/responsive': { useBp: () => ({ isDesktop: true, width: 1400 }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor }) },
    '@/src/theme/tokens': { colors: {}, spacing: {}, type: {}, radius: {}, shadow: {} },
    '@/src/design/tokens': { color: {}, font: {} },
    '@/src/api/client': { api: { get: (path, options) => { if (path.includes('shortages')) return Promise.resolve({ items: [] }); const pending = deferred(); facets.push({ ...pending, path, floor: options?.floorId }); return pending.promise; } } },
    '@/src/api/purchases': {
      getPurchasesPage: (_query, signal, floorId) => { const pending = deferred(); pages.push({ ...pending, signal, floor: floorId }); return pending.promise; },
      getPurchaseCustomers: (_signal, _completed, floorId) => { const pending = deferred(); customerReads.push({ ...pending, floor: floorId }); return pending.promise; },
    },
  };
  const exports = {};
  vm.runInNewContext(compile(instrumented), { exports, require: id => modules[id] || {}, AbortController, setTimeout, clearTimeout });
  const flush = () => { while (effects.length) effects.shift()(); };
  const render = (withEffects = true) => { index = 0; dirty = false; state = exports.default(); if (withEffects) flush(); return state; };
  return { pages, facets, customerReads, render, flush, get state() { return state; },
    switchFloor(value, withEffects = true) { floor = value; render(withEffects); },
    unmount() { hooks.forEach(hook => hook.cleanup?.()); },
    async settle() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); if (dirty) render(false); } },
  };
}

test('purchases reject an old-floor result even before passive effects start the new request', async () => {
  const fixture = screen(); fixture.render();
  const old = fixture.pages[0];
  fixture.switchFloor('third-floor', false);
  old.resolve(response('Sanitary purchase')); await fixture.settle();
  assert.equal(fixture.state.items.length, 0);
  fixture.flush();
  assert.equal(fixture.pages.at(-1).floor, 'third-floor');
  fixture.pages.at(-1).resolve(response('Furniture purchase')); await fixture.settle();
  assert.equal(fixture.state.items[0].name, 'Furniture purchase'); fixture.unmount();
});

test('retained purchase callbacks cannot request their old floor or replace the new one', async () => {
  const fixture = screen(); fixture.render();
  const old = fixture.state;
  fixture.switchFloor('ground-floor');
  const counts = [fixture.pages.length, fixture.facets.length, fixture.customerReads.length];
  await Promise.all([old.loadItems(), old.loadFacets(), old.loadCustomers()]);
  assert.deepEqual([fixture.pages.length, fixture.facets.length, fixture.customerReads.length], counts);
  assert.equal(fixture.pages.at(-1).floor, 'ground-floor'); fixture.unmount();
});

test('old purchase failures and late results cannot publish after floor change or unmount', async () => {
  const fixture = screen(); fixture.render();
  fixture.switchFloor('second-floor', false);
  fixture.pages[0].reject({ detail: 'Old sanitary request failed' }); await fixture.settle();
  assert.equal(fixture.state.itemsError, null);
  fixture.flush(); fixture.unmount();
  fixture.pages.at(-1).resolve(response('Late kitchen purchase')); await fixture.settle();
  assert.equal(fixture.state.items.length, 0);
});
