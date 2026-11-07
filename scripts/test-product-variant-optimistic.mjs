import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/quotation/sheets/ProductModal.tsx', import.meta.url), 'utf8');
const marker = '  useEffect(() => {\n    setSourceEntries(';
assert.ok(source.includes(marker));
const compiled = ts.transpileModule(source.replace(marker,
  '  return { saveVariantName, setVariantName, variantName, variantNameBusy, variantNameEditing };\n' + marker), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture() {
  const hooks = [], effects = [], requests = [], updates = [], notices = [];
  let index = 0, dirty = false, state, floor = 'first-floor', actor = 'actor-a';
  let product = { id: 'p1', name: 'Basin', sku: 'SKU', variant_label: 'Chrome', price: 100, mrp: 120 };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const slot = index++; hooks[slot] ||= { value: initial }; return [hooks[slot].value, next => { hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next; dirty = true; }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useMemo(fn, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: fn(), deps }; return hooks[slot].value; },
    useEffect(fn, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = fn(); }); } },
  };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'web' }, StyleSheet: { create: value => value } },
    '@/src/design/responsive': { useBp: () => ({ isPhone: false }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor, floors: [] }) },
    '@/src/state/auth': { useAuth: () => ({ staff: { id: actor, role: 'owner' } }) },
    '@/src/hooks/use-permissions': { useActionAccess: () => true },
    '@/src/theme/tokens': { colors: {}, radius: {}, shadow: {}, spacing: {} },
    '@/src/design/tokens': { color: {} },
    '../helpers/media': { productImageList: () => [] },
    '../context/BuilderContext': { useBuilder: () => ({ productModal: product, patchProduct(id, patch) { updates.push({ id, ...patch }); if (product?.id === id) product = { ...product, ...patch }; dirty = true; } }) },
    '@/src/components/Toast': { toast: { success: text => notices.push(text), error: text => notices.push(text) } },
    '@/src/services/catalogService': { clearCatalogCache() {} },
    '@/src/api/client': { api: { patch(path, body, options) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ path, body, options, resolve, reject });
      return promise;
    } } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {} });
  const render = () => { index = 0; dirty = false; state = exports.ProductModal(); while (effects.length) effects.shift()(); };
  render();
  return {
    requests, updates, notices, get state() { return state; },
    navigate(id = product?.id, nextFloor = floor, nextActor = actor, fields = {}) {
      product = { ...product, id, ...fields }; floor = nextFloor; actor = nextActor; render();
    },
    unmount() { hooks.forEach(hook => hook.cleanup?.()); },
    async settle() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); if (dirty) render(); } },
  };
}

test('variant label changes immediately and reconciles a normalized server label with one write', async () => {
  const view = fixture();
  await view.settle();
  view.state.setVariantName('  Matt Black  '); await view.settle();
  const pending = view.state.saveVariantName();
  void view.state.saveVariantName();
  assert.equal(view.updates[0].variant_label, 'Matt Black');
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].options.floorId, 'first-floor');
  view.requests[0].resolve({ variant_label: 'Matte Black' });
  await pending; await view.settle();
  assert.equal(view.updates.at(-1).variant_label, 'Matte Black');
  assert.equal(view.state.variantNameBusy, false);
  view.unmount();
});

test('failed variant rename restores the prior label and the retry draft', async () => {
  const view = fixture(); await view.settle();
  view.state.setVariantName('Matt Black'); await view.settle();
  const pending = view.state.saveVariantName();
  await view.settle();
  view.requests[0].reject(new Error('Fixture failure'));
  await pending; await view.settle();
  assert.equal(view.updates.at(-1).variant_label, 'Chrome');
  assert.equal(view.state.variantName, 'Matt Black');
  assert.equal(view.state.variantNameEditing, true);
  assert.equal(view.notices.length, 1);
  view.unmount();
});

test('a late variant result cannot publish into a new account or floor even after returning', async () => {
  const view = fixture(); await view.settle();
  view.state.setVariantName('Matt Black'); await view.settle();
  const pending = view.state.saveVariantName();
  view.navigate('p2', 'ground-floor', 'actor-b');
  view.navigate('p1', 'first-floor', 'actor-a');
  view.requests[0].resolve({ variant_label: 'Stale Black' });
  await pending; await view.settle();
  assert.equal(view.updates.length, 1);
  assert.deepEqual(view.notices, []);
  view.unmount();
});

test('failure after selecting a sibling restores only the renamed variant without reopening the editor', async () => {
  const view = fixture(); await view.settle();
  view.state.setVariantName('Matt Black'); await view.settle();
  const pending = view.state.saveVariantName();
  view.navigate('p2', 'first-floor', 'actor-a', { variant_label: 'Polished Chrome' }); await view.settle();
  view.requests[0].reject(new Error('Fixture failure'));
  await pending; await view.settle();
  assert.equal(view.updates.at(-1).id, 'p1');
  assert.equal(view.updates.at(-1).variant_label, 'Chrome');
  assert.equal(view.state.variantNameEditing, false);
  assert.equal(view.state.variantName, 'Polished Chrome');
  assert.deepEqual(view.notices, []);
  view.unmount();
});

test('a sibling selected during a rename keeps its own edit draft after the acknowledgement', async () => {
  const view = fixture(); await view.settle();
  view.state.setVariantName('Matt Black'); await view.settle();
  const pending = view.state.saveVariantName();
  view.navigate('p2', 'first-floor', 'actor-a', { variant_label: 'Polished Chrome' }); await view.settle();
  view.requests[0].resolve({ variant_label: 'Matte Black' });
  await pending; await view.settle();
  assert.equal(view.state.variantNameBusy, false);
  assert.equal(view.state.variantName, 'Polished Chrome');
  assert.equal(view.state.variantNameEditing, false);
  assert.equal(view.updates.at(-1).id, 'p1');
  assert.equal(view.updates.at(-1).variant_label, 'Matte Black');
  assert.deepEqual(view.notices, []);
  view.unmount();
});
