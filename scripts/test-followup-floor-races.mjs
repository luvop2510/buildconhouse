import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/followups.tsx', import.meta.url), 'utf8');
assert.match(source, /<FollowupsWorkspace key=\{selectedFloorId\}/);
const marker = '  // ── Filtering (100% client-side';
const instrumented = source.replace('function FollowupsWorkspace()', 'export function FollowupsWorkspace()')
  .replace(marker, '  return { loadList, loadDetail, refreshStatsQuiet, contact, rawItems, detail, stats };\n' + marker);
assert.notEqual(instrumented, source);
const compiled = ts.transpileModule(instrumented, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(floor = 'first-floor') {
  const hooks = [], effects = [], requests = [], links = [], notices = [];
  let index = 0, dirty = false, state;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    memo: value => value,
    useState(initial) { const slot = index++; hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[slot].value, next => { hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next; dirty = true; }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(value, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value, deps }; return hooks[slot].value; },
    useMemo(fn, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: fn(), deps }; return hooks[slot].value; },
    useEffect(fn, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = fn(); }); } },
  };
  const request = (path, bodyOrOptions, options) => { const pending = deferred(); requests.push({ path, options: options || bodyOrOptions, ...pending }); return pending.promise; };
  const modules = {
    react,
    'react-native': { StyleSheet: { create: value => value, hairlineWidth: 1 }, Platform: { OS: 'web' }, Linking: { openURL: url => { links.push(url); return Promise.resolve(); } } },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({}), useFocusEffect() {} },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
    '@/src/design/responsive': { useBp: () => ({ isDesktop: true }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor, floors: [] }) },
    '@/src/hooks/use-permissions': { useActionAccess: () => true },
    '@/src/state/auth': { useAuth: () => ({ staff: { role: 'owner', id: 'owner' } }) },
    './followup-assignments': { MANAGER_ROLES: ['owner'] },
    '@/src/theme/tokens': { colors: {}, spacing: {}, type: new Proxy({}, { get: () => ({}) }), radius: {}, elevation: {} },
    '@/src/api/client': { api: { get: request, post: request } },
    '@/src/components/Toast': { toast: { success: text => notices.push(text), error: text => notices.push(text) } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, AbortController, URLSearchParams, setTimeout, clearTimeout });
  const render = () => { index = 0; dirty = false; state = exports.FollowupsWorkspace(); while (effects.length) effects.shift()(); };
  render();
  return { requests, links, notices, get state() { return state; }, unmount() { hooks.forEach(hook => hook.cleanup?.()); },
    async settle() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); if (dirty) render(); } },
  };
}

test('an abandoned floor cannot publish a late list, detail or summary into the shared inbox', async () => {
  const old = fixture();
  void old.state.loadDetail('sanitary-one');
  void old.state.refreshStatsQuiet();
  old.unmount();
  const current = fixture('third-floor');
  for (const pending of old.requests) pending.resolve(pending.path.includes('/page?')
    ? { items: [{ id: 'sanitary-one' }], page: 1, has_more: false }
    : pending.path.includes('/stats') ? { today_tasks: 99 } : { followup: { id: 'sanitary-one' } });
  await old.settle(); await current.settle();
  assert.equal(old.state.rawItems.length, 0);
  assert.equal(old.state.detail, null);
  assert.equal(old.state.stats, null);
  assert.equal(current.state.rawItems.length, 0);
  assert.ok(current.requests.every(request => request.options.floorId === 'third-floor'));
  current.unmount();
});

test('a pending old-floor contact cannot open another app after switching workspaces', async () => {
  const old = fixture();
  old.state.contact({ id: 'sanitary-one' }, 'whatsapp');
  const pending = old.requests.find(request => request.path.endsWith('/contact'));
  assert.equal(pending.options.floorId, 'first-floor');
  old.unmount(); pending.resolve({ wa_url: 'https://wa.me/9000000000' }); await old.settle();
  assert.equal(old.links.length, 0); assert.equal(old.notices.length, 0);
  const count = old.requests.length;
  await old.state.loadList(); await old.state.refreshStatsQuiet();
  old.state.contact({ id: 'sanitary-one' }, 'call');
  assert.equal(old.requests.length, count);
});

// Model a first click after layout but before passive effects. Initializing the
// sheet in a passive effect must not erase a choice or typed Lost reason.
const callOutcomeStart = source.indexOf('function CallOutcomeSheet(');
const callOutcomeBodyEnd = source.indexOf('  if (!f) return null;', callOutcomeStart);
assert.ok(callOutcomeStart >= 0 && callOutcomeBodyEnd > callOutcomeStart);
const callOutcomeSource = source.slice(callOutcomeStart, callOutcomeBodyEnd) +
  '  return { outcome, notes, setOutcome, setNotes };\n}\nexport { CallOutcomeSheet };';
const callOutcomeCompiled = ts.transpileModule(callOutcomeSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
function callOutcomeFixture() {
  const slots = [], layout = [], passive = [];
  let cursor = 0, current;
  const schedule = queue => (callback, deps) => {
    const index = cursor++;
    if (!slots[index]?.deps || deps.some((value, i) => !Object.is(value, slots[index].deps[i]))) {
      slots[index] = { deps };
      queue.push(callback);
    }
  };
  const exports = {};
  vm.runInNewContext(callOutcomeCompiled, { exports,
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: initial };
      return [slots[index].value, value => { slots[index].value = value; }];
    },
    useEffect: schedule(passive), useLayoutEffect: schedule(layout),
    useFloorAccess: () => ({ selectedFloorId: 'first-floor', floors: [{ id: 'first-floor' }] }),
  });
  const props = { visible: false, f: null };
  const render = () => {
    cursor = 0;
    current = exports.CallOutcomeSheet(props);
    while (layout.length) layout.shift()();
    cursor = 0; current = exports.CallOutcomeSheet(props);
    return current;
  };
  const flushPassive = () => { while (passive.length) passive.shift()(); };
  render(); flushPassive();
  props.visible = true; props.f = { id: 'first-call', floor_id: 'first-floor' };
  render();
  return { render, flushPassive, get state() { return current; } };
}

test('opening call outcome initializes before the first choice and Lost reason', () => {
  const h = callOutcomeFixture();
  h.state.setOutcome('lost'); h.state.setNotes('Client chose another vendor');
  h.render(); h.flushPassive();
  const actual = h.render();
  assert.equal(actual.outcome, 'lost', 'delayed initialization cannot erase the first selected outcome');
  assert.equal(actual.notes, 'Client chose another vendor', 'delayed initialization cannot erase the first Lost reason');
});
