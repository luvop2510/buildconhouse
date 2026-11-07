import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/walkins/[id].tsx', import.meta.url), 'utf8');
assert.match(source, /<WalkInWorkspace key=\{`\$\{staff\?\.id/);
const marker = '  const filteredAssignees =';
const code = ts.transpileModule(source.replace('function WalkInWorkspace()', 'export function WalkInWorkspace()')
  .replace(marker, '  return { w, confirmedWalkin, pendingPatch, updateStatus, reassign, visitShowroom, deleteWalkin, load, busy, setNotes };\n' + marker), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const record = () => ({ id: 'one', floor_id: 'ground-floor', status: 'new', salesperson_id: 'old', salesperson_name: 'Previous', customer_name: 'Fixture' });
function fixture() {
  const slots = [], effects = [], requests = [], notices = [];
  let cursor = 0, dirty = false, state, mounted = true;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const index = cursor++; slots[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true; }]; },
    useRef(initial) { return slots[cursor++] ||= { current: initial }; },
    useCallback(value, deps) { const index = cursor++; if (!same(slots[index]?.deps, deps)) slots[index] = { value, deps }; return slots[index].value; },
    useEffect(fn, deps) { const index = cursor++; if (!same(slots[index]?.deps, deps)) { const cleanup = slots[index]?.cleanup; slots[index] = { deps }; effects.push(() => { cleanup?.(); slots[index].cleanup = fn(); }); } },
  };
  const request = method => (...args) => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); requests.push({ method, args, resolve, reject }); return promise; };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'web' } },
    'expo-router': { useLocalSearchParams: () => ({ id: 'one', floor_id: 'ground-floor' }), useRouter: () => ({ push() {} }) },
    '@/src/state/auth': { useAuth: () => ({ staff: { id: 'owner', role: 'owner' } }) },
    '@/src/hooks/use-permissions': { useModuleAccess: () => () => true },
    '@/src/design/responsive': { useBp: () => ({ isPhone: true }) },
    '@/src/components/Toast': { toast: { success: value => notices.push(value), error: value => notices.push(value) } },
    '@/src/theme/tokens': { colors: {}, spacing: {}, type: {} },
    '@/src/api/walkins': { walkinsApi: { get: request('get'), timeline: request('timeline'), update: request('update'), reassign: request('reassign'), visitShowroom: request('visitShowroom'), remove: request('remove'), listAssignees: async () => [{ id: 'new', full_name: 'Next salesperson' }] } },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => modules[id] || {} });
  const render = () => { cursor = 0; dirty = false; state = exports.WalkInWorkspace(); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let i = 0; i < 16; i++) { await Promise.resolve(); if (mounted && dirty) render(); } };
  render();
  return { requests, notices, settle, get state() { return state; },
    async ready() { requests.find(x => x.method === 'get').resolve(record()); requests.find(x => x.method === 'timeline').resolve([]); await settle(); },
    unmount() { mounted = false; slots.forEach(slot => slot.cleanup?.()); },
  };
}

for (const action of ['status', 'reassign']) test(`${action} preview is immediate, duplicate writes are coalesced and failed changes roll back visibly`, async () => {
  const f = fixture(); await f.ready();
  const start = () => action === 'status' ? f.state.updateStatus('selection_scheduled') : f.state.reassign('new');
  const pending = start(), duplicate = start(); await f.settle();
  const write = f.requests.find(x => x.method === (action === 'status' ? 'update' : 'reassign'));
  assert.equal(f.requests.filter(x => x.method === write.method).length, 1);
  assert.equal(f.state.busy, true);
  assert.equal(f.state.confirmedWalkin.status, 'new');
  assert.equal(action === 'status' ? f.state.w.status : f.state.w.salesperson_name, action === 'status' ? 'selection_scheduled' : 'Next salesperson');
  write.reject({ detail: 'Fixture unavailable' }); await Promise.all([pending, duplicate]); await f.settle();
  assert.equal(f.state.w.status, 'new'); assert.equal(f.state.w.salesperson_name, 'Previous');
  assert.equal(f.state.busy, false); assert.equal(f.state.pendingPatch, null);
  assert.match(f.notices.at(-1), /restored/);
  f.unmount();
});

test('acknowledged status survives stale detail reads and abandoned writes cannot publish notices', async () => {
  const f = fixture(); await f.ready();
  const refresh = f.state.load();
  const staleGet = f.requests.at(-1), staleTimeline = f.requests.at(-2);
  const pending = f.state.updateStatus('selection_scheduled');
  f.requests.at(-1).resolve({ ...record(), status: 'selection_scheduled' }); await pending; await f.settle();
  staleGet.resolve(record()); staleTimeline.resolve([]); await refresh; await f.settle();
  assert.equal(f.state.w.status, 'selection_scheduled');
  assert.equal(f.state.pendingPatch, null);
  const second = f.state.reassign('new'); const write = f.requests.at(-1);
  f.unmount(); write.reject(new Error('Old request')); await second; await f.settle();
  assert.deepEqual(f.notices, ['Walk-in updated']);
});


test('pending walk-in deletion excludes competing status and assignment writes', async () => {
  const f = fixture(); await f.ready();
  const pending = f.state.deleteWalkin();
  const remove = f.requests.at(-1);
  await f.state.updateStatus('selection_scheduled');
  await f.state.reassign('new');
  await f.state.visitShowroom();
  assert.equal(f.requests.filter(x => ['update', 'reassign', 'visitShowroom'].includes(x.method)).length, 0);
  const refresh = f.state.load();
  f.requests.at(-1).resolve(record());
  f.requests.at(-2).resolve([]);
  await refresh; await f.settle();
  remove.reject({ detail: 'Delete unavailable' }); await pending; await f.settle();
  assert.equal(f.state.w.status, 'new');
  assert.equal(f.state.busy, false, 'an optional refresh cannot strand the delete spinner');
  f.unmount();
});
