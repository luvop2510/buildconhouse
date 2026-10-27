import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/customers/[id]/edit.tsx', import.meta.url), 'utf8');
const marker = '  if (!loaded';
assert.ok(source.includes(marker));
const compiled = ts.transpileModule(source.replace(marker, '  return { name, loaded, loadError, error, tempResult, tempDialogOpen, saving, load, save, sendInvite, resetPassword, setName };\n' + marker), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture() {
  const hooks = [], effects = [], requests = [], notices = [], navigation = [];
  let cursor = 0, dirty = false, mounted = true, state, id = 'A', floor = 'first-floor', account = 'employee';
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const slot = cursor++;
      hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, value => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }];
    },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useCallback(value, deps) { const slot = cursor++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value, deps }; return hooks[slot].value; },
    useEffect(callback, deps) {
      const slot = cursor++;
      if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); }); }
    },
  };
  const router = { replace: path => navigation.push(path) };
  const request = method => (path, body, options) => {
    const pending = deferred();
    requests.push({ method, path, body: method === 'GET' || method === 'DELETE' ? undefined : body, options: method === 'GET' || method === 'DELETE' ? body : options, ...pending });
    return pending.promise;
  };
  const modules = {
    react, 'react-native': { Platform: { OS: 'web' } },
    'expo-router': { useRouter: () => router, useLocalSearchParams: () => ({ id }) },
    '@/src/design/responsive': { useBp: () => ({ isPhone: false, gutter: 16 }) },
    '@/src/state/auth': { useAuth: () => ({ staff: account ? { id: account, role: 'owner' } : null }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor }) },
    '@/src/hooks/use-permissions': { useActionAccess: () => true },
    '@/src/constants/roles': { canManageDestructiveData: () => true },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} },
    '@/src/components/Toast': { toast: { error: text => notices.push(text), success: text => notices.push(text) } },
    '@/src/api/client': { api: { get: request('GET'), patch: request('PATCH'), post: request('POST'), delete: request('DELETE') } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => modules[name] || {}, AbortController });
  const render = (flush = true) => { cursor = 0; dirty = false; state = exports.default(); if (flush) while (effects.length) effects.shift()(); return state; };
  const settle = async (flush = true) => { for (let turn = 0; turn < 16; turn++) { await Promise.resolve(); if (dirty && mounted) render(flush); } };
  render();
  return {
    requests, notices, navigation, render, settle, get state() { return state; },
    change(values, flush = true) { id = values.id ?? id; floor = values.floor ?? floor; account = values.account ?? account; render(flush); },
    unmount() { mounted = false; for (const hook of hooks) hook.cleanup?.(); },
    async ready() { requests[0].resolve({ id: 'A', name: 'Customer A', email: 'fixture@example.invalid', portal_enabled: true }); await settle(); },
  };
}

test('late customer A cannot repaint or save customer B', async () => {
  const f = fixture(); const old = f.requests[0];
  f.change({ id: 'B' });
  f.requests[1].resolve({ id: 'B', name: 'Customer B' }); await f.settle();
  old.resolve({ id: 'A', name: 'Customer A' }); await f.settle();
  assert.equal(f.state.name, 'Customer B');
  const save = f.state.save(); const patch = f.requests.at(-1);
  assert.equal(patch.path, '/customers/B'); assert.equal(patch.body.name, 'Customer B');
  assert.equal(patch.options.floorId, 'first-floor');
  patch.resolve({}); assert.equal(await save, true);
});

test('A to B to A does not revive the first A read, including before passive cleanup', async () => {
  const f = fixture(); const old = f.requests[0];
  f.change({ id: 'B' }, false); f.change({ id: 'A' }, false);
  old.resolve({ id: 'A', name: 'Obsolete A' }); await f.settle(false);
  assert.notEqual(f.state.name, 'Obsolete A');
  f.render(); await f.settle();
  f.requests.at(-1).resolve({ id: 'A', name: 'Current A' }); await f.settle();
  assert.equal(f.state.name, 'Current A');
});

for (const scope of [{ id: 'B' }, { floor: 'ground-floor' }, { account: 'other-employee' }]) {
  test(`retained edit actions cannot start requests after ${Object.keys(scope)[0]} changes`, async () => {
    const f = fixture(); await f.ready(); const old = f.state;
    f.change(scope, false); const count = f.requests.length;
    await old.load(); await old.save(); await old.sendInvite(); await old.resetPassword();
    assert.equal(f.requests.length, count);
    assert.equal(f.notices.length, 0);
    f.unmount();
  });
}

test('leaving an edit during prerequisite save prevents the old invite POST', async () => {
  const f = fixture(); await f.ready();
  const invite = f.state.sendInvite(); const patch = f.requests.at(-1);
  assert.equal(patch.method, 'PATCH'); assert.equal(patch.options.floorId, 'first-floor');
  f.change({ id: 'B' }); patch.resolve({}); await invite; await f.settle();
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(f.notices.length, 0);
});

test('current customer invite saves the captured draft and displays its credential response', async () => {
  const f = fixture(); await f.ready();
  const invite = f.state.sendInvite(); const patch = f.requests.at(-1);
  assert.equal(patch.method, 'PATCH'); assert.equal(patch.body.name, 'Customer A');
  patch.resolve({}); await f.settle(); const post = f.requests.at(-1);
  assert.equal(post.path, '/customers/A/send-invite'); assert.equal(post.options.floorId, 'first-floor');
  post.resolve({ temp_password: 'fixture-only' }); await invite; await f.settle();
  assert.equal(f.state.tempResult.temp_password, 'fixture-only'); assert.equal(f.state.tempDialogOpen, true);
});

test('late invite credential response is not displayed in another customer context', async () => {
  const f = fixture(); await f.ready();
  const invite = f.state.sendInvite(); f.requests.at(-1).resolve({}); await f.settle();
  const post = f.requests.at(-1); assert.equal(post.method, 'POST');
  f.change({ id: 'B' }); post.resolve({ temp_password: 'obsolete-fixture' }); await invite; await f.settle();
  assert.equal(f.state.tempDialogOpen, false); assert.equal(f.state.tempResult, null);
});

for (const action of ['resetPassword', 'save']) {
  test(`late ${action} success cannot alter the replacement customer`, async () => {
    const f = fixture(); await f.ready();
    const pending = f.state[action](); const request = f.requests.at(-1);
    f.change({ id: 'B' }); f.requests.at(-1).resolve({ id: 'B', name: 'Customer B' }); await f.settle();
    request.resolve({ temp_password: 'fixture-only' }); await pending; await f.settle();
    assert.equal(f.state.name, 'Customer B'); assert.equal(f.state.tempDialogOpen, false);
    assert.equal(f.state.tempResult, null); assert.equal(f.notices.length, 0); assert.equal(f.navigation.length, 0);
  });
}

test('only the latest retry may publish a read failure or success', async () => {
  const f = fixture(); const old = f.requests[0];
  const retry = f.state.load(); const current = f.requests.at(-1);
  current.resolve({ id: 'A', name: 'Retried customer' }); await retry; await f.settle();
  old.reject({ detail: 'Obsolete read failed' }); await f.settle();
  assert.equal(f.state.name, 'Retried customer'); assert.equal(f.state.loadError, false);
  assert.equal(old.options.signal.aborted, true);
});

test('failed save retains current details and permits a successful retry', async () => {
  const f = fixture(); await f.ready();
  const save = f.state.save(); f.requests.at(-1).reject({ detail: 'Fixture unavailable' });
  assert.equal(await save, false); await f.settle();
  assert.equal(f.state.name, 'Customer A'); assert.equal(f.state.error, 'Fixture unavailable'); assert.equal(f.state.saving, false);
  const retry = f.state.save(); f.requests.at(-1).resolve({});
  assert.equal(await retry, true); await f.settle(); assert.equal(f.state.saving, false);
});

test('unmounted edit ignores late load errors and retained mutation callbacks', async () => {
  const f = fixture(); const old = f.state; f.unmount();
  f.requests[0].reject({ detail: 'Canceled fixture' }); await f.settle();
  await old.load(); await old.save(); await old.sendInvite(); await old.resetPassword();
  assert.equal(f.requests.length, 1); assert.equal(f.notices.length, 0); assert.equal(f.state.loadError, false);
});
