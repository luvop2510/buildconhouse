import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(process.argv[2] || new URL('../app/(admin)/followups.tsx', import.meta.url), 'utf8');
assert.match(source, /<FollowupsWorkspace key=\{`\$\{staff\?\.id/);
const marker = '  // ── Filtering (100% client-side';
const deleteAction = source.slice(source.indexOf('  const deleteSavedView ='), source.indexOf('  // ── Export'));
const bulkActions = source.slice(source.indexOf('  const runBulk ='), source.indexOf('  // ── Saved Views'));
const instrumented = source.replace(deleteAction, '').replace(bulkActions, '').replace('function FollowupsWorkspace()', 'export function FollowupsWorkspace()')
  .replace(marker, deleteAction + bulkActions + '  return { deleteFollowup, setDeleteTarget, pendingDeleteIds, setSelectedId, runBulk, bulkComplete, bulkSnooze, setSelectedIds, selectedIds, bulkResult, completeFollowup, snoozeFollowup, customSnooze, pushDue, dismissFollowup, pendingPatches, confirmedItems, patchLocal, deleteSavedView, savedViews, setSavedViews, visibleSavedViews: typeof visibleSavedViews === \'undefined\' ? savedViews : visibleSavedViews, loadList, loadDetail, refreshStatsQuiet, contact, rawItems, detail, stats, workspace, setWorkspace, q, setQ, followupView, setFollowupView, priorityFilter, setPriorityFilter, ownerFilter, setOwnerFilter };\n' + marker);
assert.notEqual(instrumented, source);
const compiled = ts.transpileModule(instrumented, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const filters = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/filters.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: filters });
function fixture(floor = 'first-floor') {
  const hooks = [], effects = [], requests = [], links = [], notices = [];
  let index = 0, dirty = false, state;
  const routeParams = {};
  const router = { setParams(patch) { Object.assign(routeParams, patch); dirty = true; } };
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
    'expo-router': { useRouter: () => router, useLocalSearchParams: () => routeParams, useFocusEffect() {} },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
    '@/src/design/responsive': { useBp: () => ({ isDesktop: true }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor, floors: [] }) },
    '@/src/hooks/use-permissions': { useActionAccess: () => true },
    '@/src/state/auth': { useAuth: () => ({ staff: { role: 'owner', id: 'owner' } }) },
    './followup-assignments': { MANAGER_ROLES: ['owner'] },
    '@/src/theme/tokens': { colors: {}, spacing: {}, type: new Proxy({}, { get: () => ({}) }), radius: {}, elevation: {} },
    '@/src/api/client': { api: { get: request, post: request, patch: request, delete: request } },
    '@/src/utils/filters': filters,
    '@/src/components/Toast': { toast: { success: text => notices.push(text), error: text => notices.push(text) } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, AbortController, URLSearchParams, setTimeout, clearTimeout });
  const render = () => { index = 0; dirty = false; state = exports.FollowupsWorkspace(); while (effects.length) effects.shift()(); };
  render();
  return { requests, links, notices, routeParams, navigate(patch) { Object.assign(routeParams, patch); dirty = true; }, get state() { return state; }, unmount() { hooks.forEach(hook => hook.cleanup?.()); },
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

test('a floor-keyed owner inbox discards Furniture Mine before Ground or Sanitary salesperson reads', async () => {
  for (const floor of ['ground-floor', 'first-floor']) {
    const previous = fixture('third-floor');
    previous.state.setOwnerFilter('mine');
    await previous.settle();
    assert.equal(previous.state.ownerFilter, 'mine');
    const mineRead = previous.requests.filter(request => request.path.includes('/followups/page?')).at(-1);
    assert.equal(new URLSearchParams(mineRead.path.split('?')[1]).get('assigned_to'), 'owner');
    // FollowupsScreen keys this hook instance by selectedFloorId.
    previous.unmount();
    const current = fixture(floor);
    await current.settle();
    assert.equal(current.state.ownerFilter, 'all');
    for (const request of current.requests.filter(request => request.path.includes('/followups/page?'))) {
      assert.equal(request.options.floorId, floor);
      assert.equal(new URLSearchParams(request.path.split('?')[1]).has('assigned_to'), false);
    }
    current.unmount();
  }
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

test('a mounted inbox accepts showroom transfer navigation and clears filters that hide the new entry', async () => {
  const h = fixture();
  h.state.setQ('Previous quotation'); h.state.setFollowupView('won'); h.state.setPriorityFilter('critical');
  await h.settle();
  h.navigate({ workspace: 'visit_showroom', showroom_followup: 'showroom:new-walkin' });
  await h.settle();
  assert.equal(h.state.workspace, 'visit_showroom');
  assert.equal(h.state.q, ''); assert.equal(h.state.followupView, 'active'); assert.equal(h.state.priorityFilter, 'all');
  const latest = h.requests.filter(request => request.path.includes('/followups/page?')).at(-1);
  const query = new URLSearchParams(latest.path.split('?')[1]);
  assert.equal(query.get('origin'), 'visit_showroom'); assert.equal(query.get('view'), 'active');
  assert.equal(query.has('q'), false); assert.equal(query.has('priority'), false);
  h.unmount();
});

test('follow-up workspace tabs publish a route that survives navigation and reload', async () => {
  const h = fixture('ground-floor');
  h.state.setWorkspace('quotation_tiles'); await h.settle();
  assert.equal(h.routeParams.workspace, 'quotation_tiles');
  assert.equal(h.state.workspace, 'quotation_tiles');
  h.state.setWorkspace('all'); await h.settle();
  assert.equal(h.routeParams.workspace, 'all');
  h.unmount();
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

const view = id => ({ id, name: `View ${id}`, filters: {} });
test('saved view deletion is immediate, coalesces duplicate taps and rolls back visibly on failure', async () => {
  const h = fixture();
  h.state.setSavedViews([view('one'), view('two')]); await h.settle();
  const action = h.state.deleteSavedView;
  const pending = action('one'); const duplicate = action('one');
  await h.settle();
  assert.deepEqual(Array.from(h.state.visibleSavedViews, row => row.id), ['two'], 'optimistic removal before response');
  const writes = h.requests.filter(row => row.path === '/followups/saved-views/one');
  assert.equal(writes.length, 1, 'same-frame duplicate taps issue one delete');
  h.state.setSavedViews(rows => [view('new'), ...rows]); await h.settle();
  writes[0].reject({ detail: 'Fixture unavailable' }); await Promise.all([pending, duplicate]); await h.settle();
  assert.deepEqual(Array.from(h.state.visibleSavedViews, row => row.id), ['new', 'one', 'two'], 'rollback preserves newer rows and original order');
  assert.match(h.notices.at(-1), /restored/i);
  const retry = h.state.deleteSavedView('one');
  h.requests.at(-1).resolve({ ok: true }); await retry; await h.settle();
  assert.deepEqual(Array.from(h.state.visibleSavedViews, row => row.id), ['new', 'two']);
  h.unmount();
});
test('saved view responses cannot restore data or notices in an abandoned workspace', async () => {
  const h = fixture(); h.state.setSavedViews([view('one')]); await h.settle();
  const pending = h.state.deleteSavedView('one');
  const request = h.requests.at(-1); h.unmount();
  request.reject(new Error('old request')); await pending; await h.settle();
  assert.equal(h.notices.length, 0);
  assert.equal(h.state.savedViews.length, 1, 'unmounted action does not mutate confirmed source');
});


const followup = (id = 'one') => ({ id, status: 'open', bucket: 'today', customer_name: 'Fixture', customer: { name: 'Fixture' }, due_at: '2026-11-01T00:00:00Z', next_action: 'Call' });
async function loadedInbox() {
  const h = fixture();
  h.requests.find(row => row.path.includes('/page?')).resolve({ items: [followup()], page: 1, has_more: false });
  await h.settle(); return h;
}
for (const [action, args, status, bucket] of [
  ['completeFollowup', [], 'done', 'completed'],
  ['snoozeFollowup', ['1h'], 'snoozed', 'snoozed'],
  ['customSnooze', ['2026-11-08T10:00:00Z'], 'snoozed', 'snoozed'],
  ['pushDue', [7], 'open', 'this_week'],
  ['dismissFollowup', [], 'dismissed', 'completed'],
]) test(`${action} paints immediately, coalesces competing actions and restores on failure`, async () => {
  const h = await loadedInbox();
  const pending = h.state[action](h.state.rawItems[0], ...args);
  const beforeDuplicate = h.requests.length;
  const duplicate = h.state.completeFollowup(followup());
  await h.settle();
  assert.equal(h.requests.length, beforeDuplicate, 'one write per entity');
  assert.equal(h.state.rawItems[0].status, status);
  assert.equal(h.state.rawItems[0].bucket, bucket);
  assert.equal(h.state.confirmedItems[0].status, 'open', 'pending patch never replaces confirmed record');
  h.requests.at(-1).reject({ detail: 'unavailable' });
  await Promise.all([pending, duplicate]); await h.settle();
  assert.equal(h.state.rawItems[0].status, 'open');
  assert.equal(h.state.rawItems[0].bucket, 'today');
  assert.equal(h.state.pendingPatches.size, 0);
  assert.match(h.notices.at(-1), /restored/);
  h.unmount();
});

test('an old list or detail response cannot undo a confirmed optimistic change', async () => {
  const h = await loadedInbox();
  const refresh = h.state.loadList();
  const staleList = h.requests.at(-1);
  const details = h.state.loadDetail('one');
  const staleDetail = h.requests.at(-1);
  const saving = h.state.completeFollowup(followup());
  h.requests.at(-1).resolve({ ...followup(), status: 'done', completed_at: '2026-11-07T10:00:00Z' });
  await saving; await h.settle();
  staleList.resolve({ items: [followup()], page: 1, has_more: false });
  staleDetail.resolve({ followup: followup() });
  await Promise.all([refresh, details]); await h.settle();
  assert.equal(h.state.rawItems[0].status, 'done');
  assert.equal(h.state.detail, null);
  assert.equal(h.state.pendingPatches.size, 0);
  h.unmount();
});

test('pending follow-up overlays survive concurrent refresh and discard work after unmount', async () => {
  const h = await loadedInbox();
  const saving = h.state.snoozeFollowup(followup(), '1h');
  const write = h.requests.at(-1);
  const refresh = h.state.loadList();
  h.requests.at(-1).resolve({ items: [{ ...followup(), next_action: 'New description' }], page: 1, has_more: false });
  await refresh; await h.settle();
  assert.equal(h.state.rawItems[0].status, 'snoozed');
  assert.equal(h.state.rawItems[0].next_action, 'New description');
  h.unmount(); write.reject(new Error('old write')); await saving; await h.settle();
  assert.equal(h.notices.length, 0);
});


test('bulk optimistic completion reconciles successes and restores only failed rows', async () => {
  const h = fixture();
  const first = followup('one'), second = followup('two');
  h.requests.find(row => row.path.includes('/page?')).resolve({ items: [first, second], page: 1, has_more: false });
  await h.settle(); h.state.setSelectedIds(new Set(['one', 'two'])); await h.settle();
  h.state.bulkComplete(); await h.settle();
  assert.equal(h.state.pendingPatches.size, 2);
  assert.ok(h.state.rawItems.every(row => row.status === 'done'));
  const writes = h.requests.filter(row => row.path.endsWith('/complete'));
  await h.state.snoozeFollowup(first, '1h');
  assert.equal(h.requests.filter(row => row.path.endsWith('/snooze')).length, 0, 'bulk commands also lock each entity');
  writes[0].resolve({ ...first, status: 'done', completed_at: 'server-time' });
  writes[1].reject(new Error('temporary outage')); await h.settle();
  assert.equal(h.state.rawItems[0].status, 'done');
  assert.equal(h.state.rawItems[0].completed_at, 'server-time');
  assert.equal(h.state.rawItems[1].status, 'open');
  assert.equal(h.state.pendingPatches.size, 0);
  assert.deepEqual(Array.from(h.state.selectedIds), ['two']);
  assert.deepEqual(Array.from(h.state.bulkResult.failedIds), ['two']);
  h.unmount();
});

test('follow-up deletion hides immediately, admits one write and restores a failed deletion', async () => {
  const h = await loadedInbox();
  h.state.setDeleteTarget(followup()); await h.settle();
  const remove = h.state.deleteFollowup;
  const pending = remove(); const duplicate = remove(); await h.settle();
  assert.equal(h.state.rawItems.length, 0);
  assert.equal(h.state.confirmedItems.length, 1, 'confirmed list survives until acknowledgement');
  const writes = h.requests.filter(row => row.path === '/followups/one');
  assert.equal(writes.length, 1);
  writes[0].reject(new Error('unavailable')); await Promise.all([pending, duplicate]); await h.settle();
  assert.equal(h.state.rawItems[0].id, 'one');
  assert.match(h.notices.at(-1), /restored/);
  assert.equal(h.state.pendingDeleteIds.size, 0);
  h.unmount();
});

test('confirmed follow-up deletion ignores stale refreshes and preserves another open detail', async () => {
  const h = await loadedInbox();
  h.state.setDeleteTarget(followup()); await h.settle();
  const refresh = h.state.loadList(), stale = h.requests.at(-1);
  const pending = h.state.deleteFollowup();
  const write = h.requests.at(-1);
  h.state.setSelectedId('two');
  const detail = h.state.loadDetail('two');
  h.requests.at(-1).resolve({ followup: followup('two') }); await detail; await h.settle();
  write.resolve({ ok: true }); await pending; await h.settle();
  stale.resolve({ items: [followup()], page: 1, has_more: false }); await refresh; await h.settle();
  assert.equal(h.state.rawItems.length, 0);
  assert.equal(h.state.detail.followup.id, 'two');
  assert.equal(h.state.pendingDeleteIds.size, 0);
  h.unmount();
});
