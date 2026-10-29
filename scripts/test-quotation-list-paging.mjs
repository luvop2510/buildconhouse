import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/quotations/index.tsx', import.meta.url), 'utf8');
const marker = '  const filters =';
assert.ok(source.includes(marker));
const compiled = ts.transpileModule(source.replace(marker,
  '  return { items, load, loadPage, setQ, setStatusFilter, hasMore, loadingMore, pageError, loadError };\n' + marker), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function screen() {
  const hooks = [], effects = [], requests = [], timers = new Map();
  let index = 0, state, dirty = false, ready = false, view = 'pending', actor = 'worker', nextTimer = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const effect = (callback, deps) => {
    const slot = index++;
    if (!same(hooks[slot]?.deps, deps)) {
      const cleanup = hooks[slot]?.cleanup;
      hooks[slot] = { deps };
      effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
    }
  };
  const react = {
    useState(initial) { const slot = index++; hooks[slot] ||= { value: initial }; return [hooks[slot].value, value => {
      const next = typeof value === 'function' ? value(hooks[slot].value) : value;
      if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; }
    }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps }; return hooks[slot].value; },
    useEffect: effect,
  };
  const modules = {
    react, 'react/jsx-runtime': { jsx: () => null },
    'react-native': { StyleSheet: { create: value => value } },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({ view }), useFocusEffect: callback => effect(callback, [callback]) },
    '@/src/state/auth': { useAuth: () => ({ staff: { id: actor, role: 'owner' } }) },
    '@/src/hooks/use-permissions': { useActionAccess: () => true },
    '@/src/hooks/use-floor-access': { useRequireFloorAccessState: () => ({ ready }) },
    '@/src/design/responsive': { useBp: () => ({}) },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, font: {} },
    '@/src/design/tokens': { color: {}, layout: {}, space: {} },
    '@/src/utils/filters': { filterValues: value => value === 'all' ? [] : value.split(',') },
    '@/src/api/client': { api: { get: (path, options) => {
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ path, options, resolve, reject }); return promise;
    } } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, URLSearchParams,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  const render = () => { index = 0; dirty = false; state = exports.default(); while (effects.length) effects.shift()(); return state; };
  return { requests, render, get state() { return state; },
    ready(value) { ready = value; render(); }, view(value) { view = value; render(); }, actor(value) { actor = value; render(); },
    async settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } },
    timers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } render(); },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}
const rows = (start, count) => Array.from({ length: count }, (_, offset) => ({ id: `q-${start + offset}` }));
const params = request => new URL(request.path, 'https://fixture.test').searchParams;

test('Sanitary list gates access and requests only 30 summaries plus a next-page sentinel', async () => {
  const fixture = screen(); fixture.render(); assert.equal(fixture.requests.length, 0);
  fixture.ready(true); assert.equal(fixture.requests.length, 1);
  const first = fixture.requests[0];
  assert.equal(first.options.floorId, 'first-floor');
  assert.equal(params(first).get('summary'), 'true'); assert.equal(params(first).get('limit'), '31');
  first.resolve(rows(0, 31)); await fixture.settle();
  assert.equal(fixture.state.items.length, 30); assert.equal(fixture.state.hasMore, true);
  fixture.state.loadPage(true); fixture.state.loadPage(true);
  assert.equal(fixture.requests.length, 2); assert.equal(params(fixture.requests[1]).get('skip'), '30');
  fixture.requests[1].reject({ detail: 'Try again' }); await fixture.settle();
  assert.equal(fixture.state.items.length, 30); assert.equal(fixture.state.pageError, 'Try again');
  fixture.state.loadPage(true); assert.equal(params(fixture.requests[2]).get('skip'), '30');
  fixture.requests[2].resolve(rows(30, 2)); await fixture.settle();
  assert.equal(fixture.state.items.length, 32); assert.equal(fixture.state.hasMore, false);
  fixture.state.loadPage(true); assert.equal(fixture.requests.length, 3);
});

test('literal server search and status filters reset pagination and reject obsolete results', async () => {
  const fixture = screen(); fixture.render(); fixture.ready(true);
  fixture.requests[0].resolve(rows(0, 31)); await fixture.settle();
  const oldLoad = fixture.state.load;
  fixture.state.loadPage(true);
  fixture.state.setQ('Customer [.*]'); fixture.render();
  fixture.timers();
  assert.equal(params(fixture.requests[2]).get('q'), 'Customer [.*]');
  assert.equal(params(fixture.requests[2]).get('skip'), '0');
  fixture.requests[2].resolve([{ id: 'search-match' }]); await fixture.settle();
  fixture.requests[1].resolve(rows(30, 31)); await fixture.settle();
  assert.deepEqual(Array.from(fixture.state.items, row => row.id), ['search-match']);
  await oldLoad(); assert.equal(fixture.requests.length, 3);
  fixture.state.setStatusFilter('draft'); fixture.render();
  assert.equal(params(fixture.requests[3]).get('status'), 'draft,pending_approval,sent');
  assert.equal(params(fixture.requests[3]).get('skip'), '0');
});

test('lifecycle, account, access loss and unmount fence old page callbacks', async () => {
  const fixture = screen(); fixture.render(); fixture.ready(true);
  fixture.view('completed');
  fixture.requests[1].resolve([{ id: 'completed' }]); await fixture.settle();
  fixture.requests[0].resolve([{ id: 'draft' }]); await fixture.settle();
  assert.equal(fixture.state.items[0].id, 'completed');
  const oldLoad = fixture.state.load;
  fixture.actor('another-worker');
  await oldLoad(); assert.equal(fixture.requests.length, 3);
  fixture.ready(false); fixture.requests[2].resolve([{ id: 'old-account' }]); await fixture.settle();
  assert.notEqual(fixture.state.items?.[0]?.id, 'old-account');
  fixture.ready(true); fixture.unmount();
  fixture.requests[3].reject({ detail: 'After unmount' }); await fixture.settle();
  assert.equal(fixture.state.loadError, null);
});
