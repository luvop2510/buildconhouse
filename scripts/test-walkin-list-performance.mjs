import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/walkins/index.tsx', import.meta.url), 'utf8');
const marker = '  const pageHeader =';
assert.ok(source.includes(marker));
const compiled = ts.transpileModule(source.replace(marker, '  return { items, dashboard, loading, loadError, summaryError, search, searchQuery, savingSelections, activeScope, load, setSearch, setStatus, setSourceFilter, setSummaryView, scheduleSelection };\n' + marker), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const row = (id = 'ground-visitor', status = 'new') => ({ id, status, floor_id: 'ground-floor', customer_name: 'Visitor' });

function fixture() {
  const hooks = [], effects = [], requests = [], notices = [], timers = new Map();
  const floors = [{ id: 'ground-floor' }, { id: 'first-floor' }];
  let cursor = 0, dirty = false, state, floorId = 'ground-floor', now = 0, nextTimer = 0, mounted = true;
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const react = {
    useState(initial) {
      const slot = cursor++;
      hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, value => {
        const next = typeof value === 'function' ? value(hooks[slot].value) : value;
        if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; }
      }];
    },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useCallback(callback, deps) { const slot = cursor++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps }; return hooks[slot].value; },
    useEffect(callback, deps) {
      const slot = cursor++;
      if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); }); }
    },
  };
  const request = method => (...args) => { const pending = deferred(); requests.push({ method, args, ...pending }); return pending.promise; };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'web' } },
    'expo-router': { useRouter: () => ({ push() {} }) },
    '@/src/design/responsive': { useBp: () => ({ isPhone: true }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ floors, selectedFloorId: floorId }) },
    '@/src/state/auth': { useAuth: () => ({ staff: { id: 'owner', role: 'owner' } }) },
    '@/src/hooks/use-permissions': { useModuleAccess: () => () => true },
    '@/src/utils/walkinSummary': { walkinSummaryFilters: view => view ? { summary: view } : {} },
    '@/src/theme/tokens': { colors: {}, spacing: {}, type: {} },
    '@/src/components/Toast': { toast: { success: message => notices.push({ success: message }), error: message => notices.push({ error: message }) } },
    '@/src/api/walkins': { walkinsApi: { list: request('list'), dashboard: request('dashboard'), update: request('update'), listSources: async () => ({ sources: [] }) } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => modules[name] || {}, AbortController,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
  });
  const render = (flush = true) => { cursor = 0; dirty = false; state = exports.default(); if (flush) while (effects.length) effects.shift()(); };
  const settle = async (flush = true) => { for (let i = 0; i < 16; i++) { await Promise.resolve(); if (dirty && mounted) render(flush); } };
  const advance = async milliseconds => { now += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } await settle(); };
  const calls = method => requests.filter(request => request.method === method);
  render();
  return {
    requests, notices, calls, render, settle, advance, get state() { return state; },
    async ready() { calls('list')[0].resolve([row()]); calls('dashboard')[0].resolve({ total: 1 }); await settle(); },
    async type(text) { state.setSearch(text); await settle(); },
    changeFloor(id, flush = true) { floorId = id; render(flush); },
    unmount() { mounted = false; for (const hook of hooks) hook.cleanup?.(); },
  };
}

test('search coalesces keystrokes for 250ms and does not refetch floor summary on filters', async () => {
  const f = fixture(); await f.ready();
  await f.type('v'); await f.advance(80); await f.type('vi'); await f.advance(80); await f.type(' visitor ');
  await f.advance(249); assert.equal(f.calls('list').length, 1);
  await f.advance(1); assert.equal(f.calls('list').length, 2);
  assert.equal(f.calls('list')[1].args[0].search, 'visitor');
  f.state.setStatus('contacted'); await f.settle();
  f.state.setSourceFilter('Reference'); await f.settle();
  f.state.setSummaryView('today'); await f.settle();
  assert.equal(f.calls('list').length, 5);
  assert.equal(f.calls('dashboard').length, 1);
});

test('aborted older list and summary reads cannot publish after a floor switch', async () => {
  const f = fixture(); const oldList = f.calls('list')[0], oldSummary = f.calls('dashboard')[0];
  f.changeFloor('first-floor'); await f.settle();
  assert.equal(f.calls('list').length, 2); assert.equal(f.calls('dashboard').length, 2);
  assert.equal(oldList.args[1].signal.aborted, true);
  assert.equal(oldSummary.args[0].signal.aborted, true);
  f.calls('list').at(-1).resolve([{ ...row('sanitary'), floor_id: 'first-floor' }]);
  f.calls('dashboard').at(-1).resolve({ total: 2 }); await f.settle();
  oldList.resolve([row('obsolete')]); oldSummary.resolve({ total: 99 }); await f.settle();
  assert.equal(f.state.items[0].id, 'sanitary'); assert.equal(f.state.dashboard.total, 2);
});

test('a completed old query cannot publish before the replacement effect cleanup', async () => {
  const f = fixture(); const old = f.calls('list')[0];
  f.state.setStatus('contacted'); f.render(false);
  old.resolve([row('obsolete')]); await f.settle(false);
  assert.equal(f.state.items.length, 0);
  f.render(); await f.settle();
  f.calls('list').at(-1).resolve([row('current', 'contacted')]); await f.settle();
  assert.equal(f.state.items[0].id, 'current');
});

test('schedule selection updates immediately, coalesces repeated taps and refreshes summary after acknowledgement', async () => {
  const f = fixture(); await f.ready(); const before = f.state.items[0], schedule = f.state.scheduleSelection;
  const first = schedule(before), second = schedule(before); await f.settle();
  assert.equal(f.calls('update').length, 1);
  assert.equal(f.state.items[0].status, 'selection_scheduled');
  assert.equal(f.state.savingSelections.length, 1);
  assert.equal(f.notices.length, 0);
  f.calls('update')[0].resolve({ ...before, status: 'selection_scheduled', updated_at: 'acknowledged' });
  await Promise.all([first, second]); await f.settle();
  assert.equal(f.state.items[0].updated_at, 'acknowledged');
  assert.equal(f.state.savingSelections.length, 0);
  assert.equal(f.calls('dashboard').length, 2);
  assert.equal(f.notices.length, 1);
});

test('failed schedule rolls back status and leaves the same record available for explicit retry', async () => {
  const f = fixture(); await f.ready(); const before = f.state.items[0];
  const save = f.state.scheduleSelection(before); await f.settle();
  f.calls('update')[0].reject({ detail: 'Schedule unavailable' }); await save; await f.settle();
  assert.equal(JSON.stringify(f.state.items[0]), JSON.stringify(before));
  assert.equal(f.state.savingSelections.length, 0);
  assert.equal(f.notices[0].error, 'Schedule unavailable');
  assert.equal(f.calls('dashboard').length, 1);
  const retry = f.state.scheduleSelection(before); assert.equal(f.calls('update').length, 2);
  f.calls('update')[1].resolve({ ...before, status: 'selection_scheduled' }); await retry;
});

test('same-record refresh keeps pending status and a query change still publishes acknowledged status', async () => {
  const f = fixture(); await f.ready(); const save = f.state.scheduleSelection(f.state.items[0]);
  await f.type('visitor'); await f.advance(250);
  f.calls('list').at(-1).resolve([{ ...row(), status: 'contacted', customer_name: 'Refreshed visitor' }]); await f.settle();
  assert.equal(f.state.items[0].id, 'ground-visitor');
  assert.equal(f.state.items[0].customer_name, 'Refreshed visitor');
  assert.equal(f.state.items[0].status, 'selection_scheduled');
  f.calls('update')[0].resolve({ ...row(), status: 'selection_scheduled', updated_at: 'confirmed' }); await save; await f.settle();
  assert.equal(f.state.items[0].status, 'selection_scheduled');
  assert.equal(f.state.items[0].updated_at, 'confirmed');
  assert.equal(f.state.loading, false, 'background confirmation must retain the usable register');
  assert.equal(f.calls('list').at(-1).args[0].search, 'visitor');
  assert.equal(f.calls('dashboard').length, 2);
  assert.equal(f.notices.length, 1);
  f.calls('list').at(-1).resolve([{ ...row(), status: 'selection_scheduled', updated_at: 'revalidated' }]); await f.settle();
  assert.equal(f.state.items[0].status, 'selection_scheduled');
  assert.equal(f.state.items[0].updated_at, 'revalidated');
});

test('a held pre-acknowledgement GET cannot replace confirmed status; post-ack filters remain authoritative', async () => {
  const f = fixture(); await f.ready();
  f.state.setStatus('new'); await f.settle(); f.calls('list').at(-1).resolve([row()]); await f.settle();
  const save = f.state.scheduleSelection(f.state.items[0]); await f.settle();
  await f.type('visitor'); await f.advance(250);
  const held = f.calls('list').at(-1);
  f.calls('update')[0].resolve({ ...row(), status: 'selection_scheduled', updated_at: 'confirmed' }); await save; await f.settle();
  const afterAck = f.calls('list').at(-1);
  assert.notEqual(afterAck, held);
  assert.equal(afterAck.args[0].status, 'new');
  assert.equal(afterAck.args[0].search, 'visitor');
  held.resolve([row()]); await f.settle();
  assert.equal(f.state.items[0].status, 'selection_scheduled');
  assert.equal(f.state.items[0].updated_at, 'confirmed');
  afterAck.resolve([]); await f.settle();
  assert.equal(f.state.items.length, 0, 'the confirmed scheduled row no longer belongs to the New filter');
  assert.equal(f.calls('update').length, 1);
});

test('failed schedule rolls back to the refreshed server status while retaining refreshed customer data', async () => {
  const f = fixture(); await f.ready(); const save = f.state.scheduleSelection(f.state.items[0]);
  await f.type('visitor'); await f.advance(250);
  f.calls('list').at(-1).resolve([{ ...row(), status: 'contacted', customer_name: 'Latest customer name' }]); await f.settle();
  assert.equal(f.state.items[0].status, 'selection_scheduled');
  f.calls('update')[0].reject({ detail: 'Schedule unavailable' }); await save; await f.settle();
  assert.equal(f.state.items[0].status, 'contacted');
  assert.equal(f.state.items[0].customer_name, 'Latest customer name');
  assert.equal(f.state.savingSelections.length, 0);
});

test('floor changes reject retained actions and ignore late schedule acknowledgements before effects', async () => {
  const f = fixture(); await f.ready(); const old = f.state, save = old.scheduleSelection(old.items[0]); await f.settle();
  f.changeFloor('first-floor', false);
  await old.scheduleSelection(row('another-old-row'));
  f.calls('update')[0].resolve({ ...row(), status: 'selection_scheduled', updated_at: 'old-ack' }); await save; await f.settle(false);
  assert.equal(f.calls('update').length, 1);
  assert.equal(f.state.items[0].updated_at, undefined);
  assert.equal(f.notices.length, 0);
  assert.equal(f.calls('dashboard').length, 1);
  f.render(); await f.settle();
});

test('A to B to A and unmount cannot revive the first scope or publish notices', async () => {
  const f = fixture(); await f.ready(); const old = f.state, save = old.scheduleSelection(old.items[0]);
  f.changeFloor('first-floor', false); f.changeFloor('ground-floor', false);
  await old.scheduleSelection(row('obsolete-action'));
  f.calls('update')[0].resolve({ ...row(), status: 'selection_scheduled', updated_at: 'old-ack' }); await save; await f.settle(false);
  assert.equal(f.calls('update').length, 1); assert.equal(f.notices.length, 0);
  f.render(); await f.settle();
  const list = f.calls('list').at(-1); f.unmount(); list.resolve([row('after-unmount')]); await f.settle();
  await f.state.scheduleSelection(row('after-unmount-write'));
  assert.equal(f.calls('update').length, 1); assert.equal(f.notices.length, 0);
});
