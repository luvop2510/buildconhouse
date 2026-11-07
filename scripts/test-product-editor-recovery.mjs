import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/catalog/ProductEditor.tsx', import.meta.url), 'utf8');
const marker = '  return (\n    <Sheet';
assert.ok(source.includes(marker));
const compiled = ts.transpileModule(source.replace(marker,
  '  return { save, set, form, original, saving, hasChanges };\n' + marker), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const product = (id = 'p1', fields = {}) => ({ id, name: 'Basin', sku: 'SKU', price: 100, mrp: 120, ...fields });

function fixture() {
  const hooks = [], effects = [], requests = [], updates = [], notices = [];
  let index = 0, dirty = false, state, floor = 'first-floor', actorId = 'actor-a';
  let props = { productId: 'p1', visible: true, onClose() {}, onSaved: updated => updates.push(updated) };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const slot = index++; hooks[slot] ||= { value: initial }; return [hooks[slot].value, next => { hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next; dirty = true; }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useMemo(fn, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: fn(), deps }; return hooks[slot].value; },
    useEffect(fn, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = fn(); }); } },
  };
  const request = (method, path, body, options) => {
    const pending = deferred();
    requests.push({ method, path, body, options, ...pending });
    return pending.promise;
  };
  const modules = {
    react,
    'react-native': { StyleSheet: { create: value => value } },
    '@/src/design/responsive': { useBp: () => ({ isPhone: false }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor }) },
    '@/src/state/auth': { useAuth: () => ({ staff: { id: actorId } }) },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} },
    '@/src/components/Toast': { toast: { success: text => notices.push(text), error: text => notices.push(text) } },
    '@/src/api/client': { api: {
      get: (path, options) => request('GET', path, undefined, options),
      patch: (path, body, options) => request('PATCH', path, body, options),
    } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, AbortController });
  const render = () => { index = 0; dirty = false; state = exports.ProductEditor(props); while (effects.length) effects.shift()(); };
  render();
  return {
    requests, updates, notices, get state() { return state; },
    navigate(next = {}, nextFloor = floor, nextActor = actorId) { props = { ...props, ...next }; floor = nextFloor; actorId = nextActor; render(); },
    unmount() { hooks.forEach(hook => hook.cleanup?.()); },
    async settle() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); if (dirty) render(); } },
    async load(id = 'p1') {
      requests.filter(row => row.method === 'GET').forEach(row => row.resolve(row.path.startsWith('/products/') ? product(id) : []));
      await this.settle();
    },
  };
}

test('metadata preview is immediate, duplicate taps coalesce, and server normalization preserves newer typing', async () => {
  const view = fixture();
  await view.load();
  view.state.set('name', '  Basin updated  ');
  view.state.set('price', 200);
  await view.settle();
  const save = view.state.save();
  void view.state.save();
  assert.equal(view.updates[0].name, '  Basin updated  ');
  assert.equal(view.updates[0].price, undefined);
  assert.equal(view.requests.filter(row => row.method === 'PATCH').length, 1);
  assert.equal(view.requests.at(-1).options.floorId, 'first-floor');
  view.state.set('name', 'Newer draft');
  await view.settle();
  view.requests.at(-1).resolve(product('p1', { name: 'Basin updated', price: 200 }));
  await save;
  await view.settle();
  assert.equal(view.state.form.name, 'Newer draft');
  assert.equal(view.state.original.name, 'Basin updated');
  assert.equal(view.state.original.price, 200);
  assert.equal(view.state.hasChanges, true);
  assert.equal(view.updates.at(-1).price, 200);
  view.unmount();
});

test('failed save restores displayed metadata and keeps edits for explicit retry', async () => {
  const view = fixture();
  await view.load();
  view.state.set('name', 'Updated');
  await view.settle();
  const save = view.state.save();
  view.requests.at(-1).reject(new Error('Save failed'));
  await save;
  await view.settle();
  assert.equal(view.updates.at(-1).name, 'Basin');
  assert.equal(view.state.original.name, 'Basin');
  assert.equal(view.state.form.name, 'Updated');
  assert.equal(view.state.hasChanges, true);
  assert.equal(view.state.saving, false);
  assert.deepEqual(view.notices, ['Save failed. Product details restored. Your edits are still here.']);
  view.unmount();
});

test('canceling an editor restores its metadata preview and ignores the late acknowledgement', async () => {
  const view = fixture();
  await view.load();
  view.state.set('name', 'Updated');
  await view.settle();
  const save = view.state.save();
  const pending = view.requests.at(-1);
  view.unmount();
  assert.equal(view.updates.at(-1).name, 'Basin');
  pending.resolve(product('p1', { name: 'Updated' }));
  await save;
  assert.equal(view.updates.length, 2);
  assert.deepEqual(view.notices, []);
});

test('switching product or floor cancels stale reads and prevents old save state from leaking', async () => {
  const view = fixture();
  await view.load();
  view.state.set('name', 'Updated');
  await view.settle();
  const save = view.state.save();
  const pending = view.requests.at(-1);
  view.navigate({ productId: 'p2' }, 'ground-floor');
  await view.load('p2');
  pending.reject(new Error('Old save failure'));
  await save;
  await view.settle();
  assert.equal(view.state.form.id, 'p2');
  assert.equal(view.state.form.name, 'Basin');
  assert.equal(view.state.hasChanges, false);
  assert.equal(view.state.saving, false);
  assert.deepEqual(view.notices, []);
  assert.ok(view.requests.slice(0, 3).every(row => row.options.signal.aborted));
  assert.ok(view.requests.slice(-3).every(row => row.options.floorId === 'ground-floor'));
  view.unmount();
});

test('switching products on the same account and floor restores the previous grid preview', async () => {
  const view = fixture();
  await view.load();
  view.state.set('name', 'Updated');
  await view.settle();
  const save = view.state.save();
  const pending = view.requests.at(-1);
  view.navigate({ productId: 'p2' });
  assert.equal(view.updates.at(-1).id, 'p1');
  assert.equal(view.updates.at(-1).name, 'Basin');
  await view.load('p2');
  pending.resolve(product('p1', { name: 'Updated' }));
  await save;
  assert.equal(view.updates.length, 2);
  assert.equal(view.state.form.id, 'p2');
  view.unmount();
});

test('an account transition never publishes the previous account preview or save result', async () => {
  const view = fixture();
  await view.load();
  view.state.set('name', 'Updated');
  await view.settle();
  const save = view.state.save();
  const pending = view.requests.at(-1);
  view.navigate({}, 'first-floor', 'actor-b');
  await view.load();
  pending.resolve(product('p1', { name: 'Updated' }));
  await save;
  assert.equal(view.updates.length, 1);
  assert.equal(view.state.form.name, 'Basin');
  assert.deepEqual(view.notices, []);
  view.unmount();
});
