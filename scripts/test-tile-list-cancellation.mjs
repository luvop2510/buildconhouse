import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const calls = [], exports = {};
const api = new Proxy({}, { get: (_, method) => (...args) => { calls.push({ method, args }); return Promise.resolve({}); } });
const source = readFileSync(new URL('../src/api/tileOrders.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, require: name => name.endsWith('floors') ? { TILES_FLOOR_ID: 'ground-floor' } : { api } });
for (const name of ['listCustomerOrders', 'listBrands', 'listHistory', 'listInventory', 'listMovements', 'listDispatchList']) {
  const controller = new AbortController();
  await exports.tileOrdersApi[name]({ page: 2, search: 'literal + tile' }, controller.signal);
  const { method, args: [path, options] } = calls.at(-1);
  assert.equal(method, 'get'); assert.equal(options.floorId, 'ground-floor'); assert.equal(options.signal, controller.signal);
  assert.equal(new URL(path, 'https://fixture.test').searchParams.get('search'), 'literal + tile');
  controller.abort(); assert.equal(options.signal.aborted, true);
}
await exports.tileOrdersApi.markDelivered('dispatch', { received_by: 'Fixture' });
assert.equal(calls.at(-1).args[2].signal, undefined, 'List cancellation must never affect a business write');
console.log('All six Tile Orders list reads retain exact floor/query and consumer cancellation; writes are unchanged.');

// Execute the real brand queue's hooks so lifecycle, paging and cancellation
// assertions cover production callbacks rather than source spelling.
const brandSource = readFileSync(new URL('../app/(admin)/tiles/orders/brands/[brandId].tsx', import.meta.url), 'utf8');
const brandCompiled = ts.transpileModule(brandSource.replace('  const columns = useMemo', '  return { orders, kpi, loading, page, hasMore, loadError, failedPage, load };\n  const columns = useMemo'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function brandQueue() {
  const hooks = [], effects = [], requests = [];
  let index = 0, dirty = false, state, brandId = 'brand-A';
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const slot = index++; hooks[slot] ||= { value: initial }; return [hooks[slot].value, value => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps }; return hooks[slot].value; },
    useEffect(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps, setup: callback }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); }); } },
  };
  const modules = {
    react, 'react/jsx-runtime': { jsx: () => null },
    'react-native': { StyleSheet: { create: value => value } },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({ brandId }) },
    '@/src/hooks/use-floor-access': { useRequireFloorAccess() {} },
    '@/src/theme/tokens': { colors: {}, spacing: {}, type: {} },
    '@/src/components/Toast': { toast: { error() {} } },
    '@/src/api/tileOrders': { tileOrdersApi: { brandOrders(id, params, signal) {
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ id, params, signal, resolve, reject }); return promise;
    } } },
  };
  const exports = {};
  vm.runInNewContext(brandCompiled, { exports, require: id => modules[id] || {}, AbortController });
  const render = () => { index = 0; dirty = false; state = exports.default(); while (effects.length) effects.shift()(); return state; };
  return { requests, render, get state() { return state; }, navigate(id) { brandId = id; render(); },
    unmount() { for (const hook of hooks) hook.cleanup?.(); }, replayEffects() { for (const hook of hooks) { if (hook.setup) { hook.cleanup?.(); hook.cleanup = hook.setup(); } } }, async settle() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); if (dirty) render(); } } };
}
const brandPage = (start, hasMore = true) => ({ kpi: { orders: 90 }, orders: Array.from({ length: 30 }, (_, i) => ({ po_id: `po-${start + i}` })), has_more: hasMore });
const queue = brandQueue(); queue.render(); queue.requests[0].resolve(brandPage(0)); await queue.settle();
for (const page of [2, 3, 2, 1]) {
  const pending = queue.state.load(page); await queue.settle();
  assert.equal(queue.state.loading, true, 'Brand paging must expose pending feedback');
  const requestsBeforeRepeat = queue.requests.length;
  await queue.state.load(page);
  assert.equal(queue.requests.length, requestsBeforeRepeat, 'Repeated paging taps must coalesce synchronously');
  assert.equal(queue.state.orders.length, 30, 'Keep previous page mounted while loading');
  queue.requests.at(-1).resolve(brandPage((page - 1) * 30, page < 3)); await pending; await queue.settle();
  assert.equal(queue.state.orders.length, 30, 'Ordinary brand queue must stay bounded to one page');
  assert.equal(queue.state.orders[0].po_id, `po-${(page - 1) * 30}`);
  assert.equal(queue.state.page, page);
}
const failedPageRead = queue.state.load(2); await queue.settle();
queue.requests.at(-1).reject({ detail: 'Second page unavailable' }); await failedPageRead; await queue.settle();
assert.equal(queue.state.orders[0].po_id, 'po-0', 'Failed paging retains last acknowledged page');
assert.equal(queue.state.page, 1);
assert.equal(queue.state.failedPage, 2, 'Retry targets the failed page');
assert.equal(queue.state.loadError, 'Second page unavailable');
const retryPageRead = queue.state.load(queue.state.failedPage);
assert.equal(queue.requests.at(-1).params.page, 2);
queue.requests.at(-1).resolve(brandPage(30)); await retryPageRead; await queue.settle();
assert.equal(queue.state.orders[0].po_id, 'po-30');
assert.equal(queue.state.loadError, null);
const staleLoad = queue.state.load;
const oldRead = queue.state.load(2); queue.navigate('brand-B'); await queue.settle();
assert.equal(queue.requests.at(-2).signal.aborted, true, 'Navigating brands cancels obsolete read');
assert.equal(queue.state.orders.length, 0, 'Old brand records must clear on navigation');
const newReads = queue.requests.length;
await staleLoad(3); assert.equal(queue.requests.length, newReads, 'Retained callbacks cannot start obsolete-brand reads');
queue.requests.at(-1).resolve(brandPage(60, false)); await queue.settle();
queue.requests.at(-2).resolve(brandPage(30)); await oldRead; await queue.settle();
assert.equal(queue.state.orders[0].po_id, 'po-60');
const pending = queue.state.load(2); queue.unmount();
assert.equal(queue.requests.at(-1).signal.aborted, true, 'Unmount cancels brand read');
queue.requests.at(-1).reject({ detail: 'Old failure' }); await pending;
console.log('Brand release queue keeps one mounted page, coalesces paging and cancels obsolete reads.');

const replay = brandQueue(); replay.render(); replay.replayEffects(); await replay.settle();
assert.equal(replay.requests.length, 2);
assert.equal(replay.requests[0].signal.aborted, true);
replay.requests[0].resolve(brandPage(0)); await replay.settle();
assert.equal(replay.state.loading, true, 'An obsolete effect completion cannot clear the active read busy state');
replay.requests[1].resolve(brandPage(30)); await replay.settle();
assert.equal(replay.state.loading, false);
assert.equal(replay.state.orders[0].po_id, 'po-30');
