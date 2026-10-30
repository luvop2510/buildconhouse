import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { mergeReferences, referenceDestination } from '../src/components/salesData/ReferencesModel.ts';
import { referrerCode } from '../src/utils/referrer.ts';

const source = readFileSync(new URL('../src/components/salesData/ReferrerDirectory.tsx', import.meta.url), 'utf8');
const instrumented = source.replace('  return <Card', '  return { directory, current, loading, error, currentError, active, historical, load, setSearch, setFilter, startEditing, saved };\n  return <Card');
assert.notEqual(instrumented, source);
const compiled = ts.transpileModule(instrumented, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const contact = (id, extra = {}) => ({ id, name: id, type: 'architect', shared_across_floors: false, updated_at: 'v1', ...extra });
function fixture() {
  const hooks = [], effects = [], timers = new Map(), requests = [];
  let index = 0, clock = 0, latestProps = {}, identity = { id: 'owner', role: 'owner' };
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const react = {
    useState(initial) {
      const slot = index++; hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, value => { hooks[slot].value = typeof value === 'function' ? value(hooks[slot].value) : value; }];
    },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useMemo(callback) { index++; return callback(); },
    useCallback(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps };
      return hooks[slot].value;
    },
    useEffect(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) {
        const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps };
        effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
      }
    },
  };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'web' }, useWindowDimensions: () => ({ fontScale: 1 }) },
    '@/src/api/client': { api: { get: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })) } },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: 'first-floor', floors: [{ id: 'first-floor' }, { id: 'ground-floor' }] }) },
    '@/src/state/auth': { useAuth: () => ({ staff: identity }) },
    '@/src/design/responsive': { useBp: () => ({ isPhone: false, isTabletPortrait: false }) },
    './ReferencesModel': { mergeReferences, referenceDestination },
    '@/src/utils/referrer': { referrerCode },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, URLSearchParams, AbortController,
    setTimeout: callback => { const id = ++clock; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  const flush = () => { while (effects.length) effects.shift()(); };
  return {
    requests,
    render(props = {}, flushEffects = true) {
      latestProps = { ...latestProps, ...props }; index = 0;
      const result = exports.ReferrerDirectory({ floorId: 'first-floor', ...latestProps });
      if (flushEffects) flush();
      return result;
    },
    start() { for (const [id, timer] of [...timers]) { timers.delete(id); timer(); } },
    flush,
    async settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); },
    identity(next) { identity = next; },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}
const page = (rows, total = rows.length, offset = 0) => ({ rows, total, offset, limit: 25 });

test('off-page active references stay out of historical rows; actual historical identities preserve period links', () => {
  const rows = mergeReferences([contact('loaded')], [
    { ...contact('loaded'), customers_acquired: 3, historical: false },
    { ...contact('off-page'), customers_acquired: 1, historical: false },
    { ...contact('archived'), customers_acquired: 2, historical: true },
  ]);
  assert.deepEqual(rows.map(row => [row.contact.id, row.historical]), [['archived', true], ['loaded', false]]);
  assert.equal(rows[1].performance.customers_acquired, 3);
  const url = referenceDestination('archived', 'ground-floor', { preset: 'custom', dateFrom: '2026-10-01', dateTo: '2026-11-01' });
  assert.match(url, /floorId=ground-floor&preset=custom&dateFrom=2026-10-01&dateTo=2026-11-01/);
});

test('all-floor directory sends one authorized-union page, and duplicate append taps share one request', async () => {
  const view = fixture(); view.render({ floorId: 'all' }); view.start();
  assert.equal(view.requests.length, 1);
  const first = new URLSearchParams(view.requests[0].path.split('?')[1]);
  assert.equal(first.get('floor_id'), 'first-floor,ground-floor'); assert.equal(first.get('limit'), '25');
  view.requests[0].resolve(page([contact('first')], 51)); await view.settle();
  const current = view.render(); current.load(25); current.load(25);
  assert.equal(view.requests.length, 2);
  assert.equal(view.requests[1].options.signal.aborted, false);
  view.requests[1].resolve(page([contact('second')], 51, 25)); await view.settle();
  assert.deepEqual(Array.from(view.render().active, row => row.contact.id), ['first', 'second']);
});

test('late prior query cannot publish even before passive cleanup runs', async () => {
  const view = fixture(); let state = view.render(); view.start();
  state.setSearch('new'); state = view.render({}, false);
  view.requests[0].resolve(page([contact('old')])); await view.settle();
  assert.equal(view.render({}, false).current, false);
  view.flush(); view.start();
  view.requests[1].resolve(page([contact('new')])); await view.settle();
  assert.deepEqual(Array.from(view.render().active, row => row.contact.id), ['new']);
});

test('late floor and account responses cannot publish into the newly selected scope', async () => {
  for (const change of ['floor', 'account']) {
    const view = fixture(); view.render(); view.start();
    if (change === 'account') view.identity({ id: 'other', role: 'owner' });
    view.render(change === 'floor' ? { floorId: 'ground-floor' } : {}, false);
    view.requests[0].resolve(page([contact('old')])); await view.settle();
    assert.equal(view.render({}, false).current, false);
    view.flush(); view.start(); view.requests[1].resolve(page([contact('current')])); await view.settle();
    assert.deepEqual(Array.from(view.render().active, row => row.contact.id), ['current']);
  }
});

test('held save completion refreshes latest search and latest period callback instead of its captured query', async () => {
  const view = fixture(); let oldCalls = 0, currentCalls = 0;
  let state = view.render({ onSaved: () => oldCalls++ }); view.start();
  view.requests[0].resolve(page([contact('first')])); await view.settle();
  state = view.render(); state.startEditing(contact('first')); state = view.render();
  const oldSave = state.saved;
  state.setSearch('latest'); view.render({ onSaved: () => currentCalls++ }); view.start();
  oldSave(contact('saved')); view.render(); view.start();
  assert.equal(oldCalls, 0); assert.equal(currentCalls, 1);
  assert.equal(view.requests.length, 3);
  assert.equal(new URLSearchParams(view.requests[2].path.split('?')[1]).get('search'), 'latest');
  view.requests[1].resolve(page([contact('obsolete')])); view.requests[2].resolve(page([contact('latest')])); await view.settle();
  assert.deepEqual(Array.from(view.render().active, row => row.contact.id), ['latest']);
});

test('failed refresh retries offset zero, while failed append retains its exact cursor', async () => {
  for (const failedOffset of [0, 25]) {
    const view = fixture(); view.render(); view.start();
    view.requests[0].resolve(page([contact('first')], 51)); await view.settle();
    let state = view.render(); state.load(failedOffset);
    view.requests[1].reject({ detail: 'Try again' }); await view.settle();
    state = view.render(); assert.equal(state.error.offset, failedOffset);
    state.load(state.error.offset);
    assert.equal(new URLSearchParams(view.requests[2].path.split('?')[1]).get('offset'), String(failedOffset));
    view.requests[2].resolve(page([contact('fresh')], 51, failedOffset)); await view.settle();
    assert.deepEqual(Array.from(view.render().active, row => row.contact.id), failedOffset ? ['first', 'fresh'] : ['fresh']);
  }
});

test('historical search/type filters remain bounded independently of active contacts', async () => {
  const view = fixture();
  const performance = [{ ...contact('archived'), name: 'Historical studio', customers_acquired: 4, historical: true }];
  let state = view.render({ performance }); view.start(); view.requests[0].resolve(page([])); await view.settle();
  state = view.render(); assert.equal(state.historical.length, 1);
  state.setSearch('ARC-HISTORICAL-ARCHIVED'); state = view.render(); assert.equal(state.historical.length, 1);
  state.setFilter('interior_designer'); state = view.render(); assert.equal(state.historical.length, 0);
});

test('unmount prevents requests and save callbacks from a dismissed directory', async () => {
  const view = fixture(); let calls = 0;
  let state = view.render({ onSaved: () => calls++ }); view.start();
  state.startEditing(null); state = view.render(); view.unmount();
  state.load(); state.saved(contact('saved')); view.requests[0].resolve(page([contact('old')])); await view.settle();
  assert.equal(calls, 0); assert.equal(view.requests.length, 1); assert.equal(view.requests[0].options.signal.aborted, true);
});


test('a previous query error never offers its old append cursor to the new search', async () => {
  const view = fixture(); view.render(); view.start();
  view.requests[0].resolve(page([contact('first')], 51)); await view.settle();
  let state = view.render(); state.load(25);
  view.requests[1].reject({ detail: 'Append failed' }); await view.settle();
  state = view.render(); assert.equal(state.currentError.offset, 25);
  state.setSearch('new'); state = view.render({}, false);
  assert.equal(state.currentError, null);
});
