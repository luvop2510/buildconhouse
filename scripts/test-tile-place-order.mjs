import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/quotations/[id]/place-order.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace('  if (error) {', '  return { preview, error, confirmError, busy, loadPreview, confirm };\n  if (error) {'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function review(tiles = true) {
  const hooks = [], effects = [], requests = [], navigations = [];
  let index = 0, dirty = false, state, id = 'quotation-A';
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const slot = index++; hooks[slot] ||= { value: initial }; return [hooks[slot].value, value => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps }; return hooks[slot].value; },
    useEffect(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); }); } },
  };
  const api = Object.fromEntries(['get', 'post'].map(method => [method, (url, ...args) => { const pending = deferred(); requests.push({ ...pending, method, url, args }); return pending.promise; }]));
  const modules = {
    react, 'react/jsx-runtime': { jsx: () => null },
    'react-native': { StyleSheet: { create: value => value } },
    'expo-router': { useRouter: () => ({ replace: value => navigations.push(value) }), useLocalSearchParams: () => ({ id }), useSegments: () => tiles ? ['(admin)', 'tiles', 'place-order', '[id]'] : ['(admin)', 'quotations', '[id]', 'place-order'] },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
    '@/src/design/responsive': { useBp: () => ({}) },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} },
    '@/src/constants/floors': { TILES_FLOOR_ID: 'ground-floor' },
    '@/src/api/client': { api }, '@/src/components/Toast': { toast: { success() {} } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: key => modules[key] || {} });
  const render = () => { index = 0; dirty = false; state = exports.default(); while (effects.length) effects.shift()(); return state; };
  return { requests, navigations, render, get state() { return state; }, navigate(nextId) { id = nextId; render(); }, async settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } } };
}
const preview = { quotation_id: 'quotation-A', quotation_number: 'TQ-A', doc_type: 'tiles_quotation', customer_name: 'Test customer', brands: [], total_value: 100 };

test('Ground tile order preparation never calls Sanitary-only supplier API and places one order per click sequence', async () => {
  const f = review(); f.render();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/quotations/quotation-A/place-order/preview');
  assert.equal(f.requests[0].args[0].floorId, 'ground-floor');
  f.requests[0].resolve(preview); await f.settle();
  assert.equal(f.state.preview.customer_name, 'Test customer');
  const first = f.state.confirm(); const repeated = f.state.confirm();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].url, '/quotations/quotation-A/place-order/confirm');
  assert.equal(f.requests[1].args[1].floorId, 'ground-floor');
  f.requests[1].resolve({ count: 1, purchase_orders: [{ id: 'po-A' }] });
  await Promise.all([first, repeated]); await f.settle();
  assert.equal(f.navigations[0], '/(admin)/tiles/orders');
});

test('Sanitary preview retains its supplier read', async () => {
  const f = review(false); f.render();
  assert.deepEqual(f.requests.map(r => r.url), ['/quotations/quotation-A/place-order/preview', '/suppliers']);
  f.requests[0].resolve({ ...preview, doc_type: 'standard' }); f.requests[1].resolve([]); await f.settle();
  assert.equal(f.state.error, null);
  assert.equal(f.state.preview.doc_type, 'standard');
});

test('a pending old tile preview cannot replace the new quotation after navigation', async () => {
  const f = review(); f.render(); f.navigate('quotation-B');
  f.requests[1].resolve({ ...preview, quotation_id: 'quotation-B' }); await f.settle();
  f.requests[0].reject({ detail: 'Old request failed' }); await f.settle();
  assert.equal(f.state.preview.quotation_id, 'quotation-B');
  assert.equal(f.state.error, null);
});

test('late order completion cannot navigate away from another quotation', async () => {
  const f = review(); f.render(); f.requests[0].resolve(preview); await f.settle();
  const command = f.state.confirm(); f.navigate('quotation-B');
  f.requests[1].resolve({ count: 1, purchase_orders: [{ id: 'po-A' }] }); await command; await f.settle();
  assert.equal(f.navigations.length, 0);
});

test('a pending old order cannot block or clear the busy state of a new quotation order', async () => {
  const f = review(); f.render(); f.requests[0].resolve(preview); await f.settle();
  const oldCommand = f.state.confirm(); f.navigate('quotation-B');
  f.requests[2].resolve({ ...preview, quotation_id: 'quotation-B' }); await f.settle();
  assert.equal(f.state.busy, false);
  const newCommand = f.state.confirm(); await f.settle();
  assert.equal(f.requests[3].url, '/quotations/quotation-B/place-order/confirm');
  assert.equal(f.state.busy, true);
  f.requests[1].resolve({ count: 1, purchase_orders: [{ id: 'po-A' }] }); await oldCommand; await f.settle();
  assert.equal(f.state.busy, true);
  assert.equal(f.navigations.length, 0);
  f.requests[3].resolve({ count: 1, purchase_orders: [{ id: 'po-B' }] }); await newCommand; await f.settle();
  assert.equal(f.navigations.length, 1);
  assert.equal(f.state.busy, false);
});
