import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise already-resolved mutation callbacks: transport cancellation alone
// cannot protect native/retained screens after a workspace has unmounted.
const source = readFileSync(new URL('../src/components/notebook/NotebookScreen.tsx', import.meta.url), 'utf8');
const instrumented = source.replace('  const draftFields =', '  return { create, contact, convert, saveOutcome, saveEdit, savePartner, setDraft, setSearch, setFilter };\n  const draftFields =');
assert.notEqual(instrumented, source);
const compiled = ts.transpileModule(instrumented, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function fixture() {
  const hooks = [], effects = [], notices = [], links = [], requests = [];
  let index = 0, dirty = false, state;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const slot = index++;
      hooks[slot] ||= { value: initial };
      return [hooks[slot].value, value => { hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; dirty = true; }];
    },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps };
      return hooks[slot].value;
    },
    useEffect(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) {
        const cleanup = hooks[slot]?.cleanup;
        hooks[slot] = { deps };
        effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
      }
    },
  };
  const mutation = deferred();
  const api = new Proxy({}, { get: (_, method) => (...args) => {
    requests.push({ method, args });
    return method === 'list' ? Promise.resolve({ rows: [], next_cursor: null }) : mutation.promise;
  } });
  const modules = {
    react,
    'react-native': { StyleSheet: { create: value => value, hairlineWidth: 1 }, Linking: { openURL: url => { links.push(url); return Promise.resolve(); } } },
    '@/src/api/notebook': { notebookApi: api },
    '@/src/hooks/use-permissions': { useActionAccess: () => true },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ floors: [{ id: 'second-floor', name: 'Kitchen' }, { id: 'third-floor', name: 'Furniture' }] }) },
    '@/src/design/responsive': { useBp: () => ({ isPhone: false }) },
    '@/src/design/tokens': { layout: {} },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} },
    '@/src/components/Toast': { toast: { success: message => notices.push(message), error: message => notices.push(message) } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, setTimeout, clearTimeout });
  const render = () => {
    index = 0; dirty = false;
    state = exports.NotebookScreen({ floorId: 'second-floor', floorName: 'Kitchen Floor', view: 'followups' });
    while (effects.length) effects.shift()();
  };
  render();
  return {
    notices, links, requests, mutation,
    get state() { return state; },
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
    async settle() { for (let pass = 0; pass < 8; pass++) { await Promise.resolve(); if (dirty) render(); } },
  };
}

test('completed contact from an abandoned notebook cannot open another app or reload the previous floor', async () => {
  const view = fixture();
  view.state.contact({ id: 'old-lead', customer_name: 'Old customer' }, 'whatsapp');
  view.unmount();
  view.mutation.resolve({ wa_url: 'https://wa.me/9000000000' });
  await view.settle();
  assert.equal(view.links.length, 0);
  assert.equal(view.requests.filter(request => request.method === 'list').length, 0);
  assert.equal(view.notices.length, 0);
});

test('completed creation from an abandoned notebook produces no stale success notice', async () => {
  const view = fixture();
  view.state.setDraft({ customer_name: 'Old draft', customer_phone: '9000000000', kitchen_type: 'GI', interested_floor_ids: ['second-floor'], assignments: [{ floor_id: 'second-floor', user_id: 'kitchen-worker' }] });
  await view.settle();
  const create = view.state.create();
  view.unmount();
  view.mutation.resolve({ id: 'old-lead' });
  await create;
  assert.equal(view.requests.filter(request => request.method === 'create').length, 1);
  assert.equal(view.notices.length, 0);
});


test('successful creation reloads the latest active query instead of inserting a row outside its filter', async () => {
  const view = fixture();
  view.state.setDraft({ customer_name: 'New draft', customer_phone: '9000000000', kitchen_type: 'GI', interested_floor_ids: ['second-floor'], assignments: [{ floor_id: 'second-floor', user_id: 'kitchen-worker' }] });
  await view.settle();
  const create = view.state.create();
  view.state.setSearch('Different customer'); view.state.setFilter('pending');
  await view.settle();
  view.mutation.resolve({ id: 'new-lead', status: 'new', is_converted: false });
  await create;
  const lists = view.requests.filter(request => request.method === 'list');
  assert.equal(lists.length, 1);
  assert.equal(lists[0].args[0], 'second-floor');
  assert.equal(lists[0].args[1].q, 'Different customer');
  assert.equal(lists[0].args[1].status, 'pending');
  view.unmount();
});

test('a duplicate converted customer reloads canonical walk-ins and reports its existing quotation stage', async () => {
  const view = fixture();
  view.state.setDraft({ customer_name: 'Existing customer', customer_phone: '9000000000', kitchen_type: 'GI', interested_floor_ids: ['second-floor'], assignments: [{ floor_id: 'second-floor', user_id: 'kitchen-worker' }] });
  await view.settle();
  const create = view.state.create();
  view.mutation.resolve({ id: 'existing-lead', is_converted: true });
  await create;
  assert.equal(view.requests.filter(request => request.method === 'list').length, 1);
  assert.deepEqual(view.notices, ['Customer already in quotation follow-ups']);
  view.unmount();
});
