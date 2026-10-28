import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/dashboard.tsx', import.meta.url), 'utf8');
const marker = '  const loading = queue === null;';
assert.ok(source.includes(marker));
const compiled = ts.transpileModule(source.replace(marker, '  return { queue, mission, pendingIds, complete, load };\n' + marker), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const rows = ['a', 'b', 'c'].map(id => ({ id, customer_name: `Fixture ${id}`, status: 'open' }));
function fixture() {
  const hooks = [], effects = [], reads = [], writes = [], notices = [];
  let cursor = 0, dirty = false, state, floor = 'first-floor', user = 'staff-a';
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const slot = cursor++; hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, update => { hooks[slot].value = typeof update === 'function' ? update(hooks[slot].value) : update; dirty = true; }];
    },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useMemo(fn, deps) { const slot = cursor++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: fn(), deps }; return hooks[slot].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const slot = cursor++;
      if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = fn(); }); }
    },
  };
  const request = (list, path, options, body) => new Promise((resolve, reject) => list.push({ path, options, body, resolve, reject }));
  const modules = {
    react, 'expo-router': { useRouter: () => ({}) },
    '@/src/state/auth': { useAuth: () => ({ staff: { id: user, full_name: 'Fixture' } }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor }) },
    '@/src/hooks/use-permissions': { useActionAccess: () => true },
    '@/src/design/responsive': { useBp: () => ({ isPhone: false, isDesktop: true }) },
    '@/src/api/client': { api: { get: (path, options) => request(reads, path, options), post: (path, body, options) => request(writes, path, options, body) } },
    '@/src/components/Toast': { toast: { success: text => notices.push(['success', text]), error: text => notices.push(['error', text]) } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, console });
  const render = () => { cursor = 0; dirty = false; state = exports.default(); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } };
  const answer = async (start = 0) => {
    for (const read of reads.slice(start)) read.resolve(read.path.startsWith('/followups?') ? rows : read.path === '/followups/mission' ? { due_count: 3, greeting_name: 'Fixture' } : {});
    await settle();
  };
  return { reads, writes, notices, render, settle, answer, get state() { return state; },
    switchFloor() { floor = 'ground-floor'; render(); }, switchUser() { user = 'staff-b'; render(); },
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
  };
}

async function ready() { const f = fixture(); f.render(); await f.answer(); return f; }
const ids = f => Array.from(f.state.queue || [], row => row.id);

test('completion removes the row before the response and coalesces repeated taps', async () => {
  const f = await ready(); const complete = f.state.complete;
  complete(rows[0]); complete(rows[0]); await f.settle();
  assert.deepEqual(ids(f), ['b', 'c']); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].options.floorId, 'first-floor');
  assert.equal(f.notices.length, 0, 'No success announcement before acknowledgement');
  f.writes[0].resolve({ status: 'done' }); await f.settle();
  assert.deepEqual(ids(f), ['b', 'c']); assert.equal(f.state.pendingIds.length, 0);
  assert.equal(f.notices[0][0], 'success');
});

test('failure visibly restores original order without undoing another successful action', async () => {
  const f = await ready(); f.state.complete(rows[0]); f.state.complete(rows[1]); await f.settle();
  assert.deepEqual(ids(f), ['c']);
  f.writes[1].resolve({ status: 'done' }); await f.settle();
  f.writes[0].reject(new Error('Offline')); await f.settle();
  assert.deepEqual(ids(f), ['a', 'c']);
  assert.match(f.notices.at(-1)[1], /Follow-up restored/);
});

test('a delayed pre-confirmation refresh cannot resurrect a completed row', async () => {
  const f = await ready(); const start = f.reads.length;
  void f.state.load(true); f.state.complete(rows[0]); await f.settle();
  f.writes[0].resolve({ status: 'done' }); await f.settle();
  await f.answer(start);
  assert.deepEqual(ids(f), ['b', 'c']);
});

test('pending removal survives a refresh, and rejection restores that refreshed queue', async () => {
  const f = await ready(); f.state.complete(rows[0]); await f.settle();
  const start = f.reads.length; void f.state.load(true); await f.answer(start);
  assert.deepEqual(ids(f), ['b', 'c']);
  f.writes[0].reject(new Error('Rejected')); await f.settle();
  assert.deepEqual(ids(f), ['a', 'b', 'c']);
});

for (const change of ['switchFloor', 'switchUser', 'unmount']) for (const outcome of ['resolve', 'reject']) {
  test(`${change} ignores late ${outcome} and retained completion callbacks`, async () => {
    const f = await ready(); const complete = f.state.complete;
    complete(rows[0]); await f.settle(); f[change]();
    const reads = f.reads.length;
    f.writes[0][outcome](outcome === 'resolve' ? {} : new Error('Old request')); await f.settle();
    complete(rows[1]); await f.settle();
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, reads); assert.deepEqual(f.notices, []);
    if (change !== 'unmount') { await f.answer(); assert.deepEqual(ids(f), ['a', 'b', 'c']); }
  });
}

test('out-of-order summary responses cannot replace the newest confirmed summary', async () => {
  const f = await ready(); f.state.complete(rows[0]); f.state.complete(rows[1]);
  f.writes[0].resolve({}); await f.settle(); const earlier = f.reads.at(-1);
  f.writes[1].resolve({}); await f.settle(); const later = f.reads.at(-1);
  later.resolve({ due_count: 1 }); await f.settle(); earlier.resolve({ due_count: 2 }); await f.settle();
  assert.equal(f.state.mission.due_count, 1);
});
