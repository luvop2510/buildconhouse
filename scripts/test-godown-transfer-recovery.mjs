import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/godown/CustomerTransferSheet.tsx', import.meta.url), 'utf8');
const instrumented = source.replace('  return <Sheet', '  return { submit, acknowledgeRecorded, recorded, canSubmit, busy, uncertain, submitError, qty, name, customerId, setQty, setName, setCustomerId, setReloadCount };\n  return <Sheet');
assert.notEqual(instrumented, source);
const compiled = ts.transpileModule(instrumented, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function sheet() {
  const initialLot = { id: 'stock', name: 'Basin', sku: 'B-1', available_qty: 5, transferable_qty: 5, unit_price: 100 };
  const hooks = [], effects = [], writes = [], reads = [], notifications = [];
  let lot = initialLot, floor = 'first-floor', index = 0, dirty = false, state, uuid = 0, closed = 0, refreshed = 0, failRefresh = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const slot = index++; hooks[slot] ||= { value: initial }; return [hooks[slot].value, next => {
      const value = typeof next === 'function' ? next(hooks[slot].value) : next;
      if (!Object.is(value, hooks[slot].value)) { hooks[slot].value = value; dirty = true; }
    }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useMemo(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback(), deps }; return hooks[slot].value; },
    useEffect(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) {
      const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
    } },
  };
  const modules = {
    react, 'expo-crypto': { randomUUID: () => `command-${++uuid}` },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ selectedFloorId: floor }) },
    '@/src/state/auth': { useAuth: () => ({ staff: { id: 'actor' } }) },
    '@/src/design/responsive': { useBp: () => ({ isPhone: false }) },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} },
    '@/src/api/client': { api: { get: (path, options) => { reads.push({ path, floor: options.floorId }); return Promise.resolve([{ id: 'recipient', name: 'Recipient' }]); } } },
    '@/src/api/godownStock': {
      getPoFinalMatches: (id, requestFloor) => { reads.push({ path: 'matches', id, floor: requestFloor }); return Promise.resolve({ matches: [] }); },
      transferGodownStockToCustomer: (id, body, requestFloor) => { const pending = deferred(); writes.push({ ...pending, id, body, floor: requestFloor }); return pending.promise; },
    },
    '@/src/components/Toast': { toast: { success: message => notifications.push({ kind: 'success', message }), error: message => notifications.push({ kind: 'error', message }) } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {} });
  const render = () => { index = 0; dirty = false; state = exports.CustomerTransferSheet({ lot, onClose: () => { closed += 1; }, onTransferred: async () => { refreshed += 1; if (failRefresh) throw Error('refresh failed'); } }); while (effects.length) effects.shift()(); };
  return {
    writes, reads, notifications, get state() { return state; }, get closed() { return closed; }, get refreshed() { return refreshed; },
    render, context(nextFloor, opened = true) { floor = nextFloor; lot = opened ? initialLot : null; render(); },
    failRefresh() { failRefresh = true; }, unmount() { for (const hook of hooks) hook.cleanup?.(); },
    async settle() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); if (dirty) render(); } },
    async ready() { render(); await this.settle(); state.setCustomerId('recipient'); state.setQty('2'); await this.settle(); assert.equal(state.canSubmit, true); },
  };
}

test('synchronous repeated transfer admission sends one command to its captured floor', async () => {
  const f = sheet(); await f.ready(); const submit = f.state.submit;
  const first = submit(), repeated = submit(); await repeated;
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].floor, 'first-floor');
  assert.ok(f.reads.every(read => read.floor === 'first-floor'));
  f.writes[0].resolve({ recipient_customer_name: 'Recipient' }); await first; await f.settle();
  assert.equal(f.closed, 1); assert.equal(f.refreshed, 1);
});

test('uncertain close/reopen and metadata retry retain the exact submitted body', async () => {
  const f = sheet(); await f.ready(); const first = f.state.submit();
  f.writes[0].reject({ status: 504, detail: 'response lost' }); await first; await f.settle();
  assert.equal(f.state.uncertain, true);
  f.context('first-floor', false); await f.settle(); f.context('first-floor'); await f.settle();
  assert.equal(f.state.qty, '2'); assert.equal(f.state.customerId, 'recipient'); assert.equal(f.state.uncertain, true);
  f.state.setReloadCount(value => value + 1); await f.settle();
  const retry = f.state.submit(); assert.equal(f.writes[1].body, f.writes[0].body);
  f.writes[1].resolve({ recipient_customer_name: 'Recipient' }); await retry; await f.settle();
  assert.equal(f.closed, 1); assert.equal(f.state.uncertain, false);
});

test('a retained old-floor transfer callback cannot start a write or refresh the new floor', async () => {
  const f = sheet(); await f.ready(); const retained = f.state.submit, first = retained();
  f.context('ground-floor'); await f.settle(); await retained(); assert.equal(f.writes.length, 1);
  f.writes[0].resolve({ recipient_customer_name: 'Recipient' }); await first; await f.settle();
  assert.equal(f.closed, 0); assert.equal(f.refreshed, 0); assert.equal(f.notifications.length, 0);
});

test('a definitive rejection after an uncertain attempt permits correction with the same key', async () => {
  const f = sheet(); await f.ready(); const first = f.state.submit();
  f.writes[0].reject({ status: 504, detail: 'response lost' }); await first; await f.settle();
  const retry = f.state.submit(); f.writes[1].reject({ status: 422, detail: 'Review the transfer details' }); await retry; await f.settle();
  assert.equal(f.state.uncertain, false);
  f.state.setQty('1'); await f.settle(); const corrected = f.state.submit();
  assert.equal(f.writes[2].body.idempotency_key, f.writes[0].body.idempotency_key);
  assert.equal(f.writes[2].body.qty, 1);
  f.writes[2].resolve({ recipient_customer_name: 'Recipient' }); await corrected; await f.settle();
  assert.equal(f.closed, 1);
});

test('returning to an unresolved same-floor command reconciles its eventual completion', async () => {
  const f = sheet(); await f.ready(); const first = f.state.submit();
  f.context('ground-floor', false); await f.settle(); f.context('first-floor'); await f.settle();
  assert.equal(f.state.busy, true); assert.equal(f.state.uncertain, true);
  f.writes[0].resolve({ recipient_customer_name: 'Recipient' }); await first; await f.settle();
  assert.equal(f.state.busy, false); assert.equal(f.state.uncertain, false); assert.equal(f.closed, 1);
});

test('a committed conflict is reviewed and acknowledged before a fresh transfer key', async () => {
  const f = sheet(); await f.ready(); const first = f.state.submit();
  f.writes[0].reject({ status: 409, payload: { detail: { code: 'godown_transfer_already_recorded', message: 'Already recorded',
    transfer: { id: 'receipt', stock_id: 'stock', floor_id: 'first-floor', qty: 2, recipient_customer_name: 'Original recipient' } } } });
  await first; await f.settle(); assert.equal(f.state.recorded.id, 'receipt'); assert.equal(f.state.canSubmit, false);
  f.context('first-floor', false); await f.settle(); f.context('first-floor'); await f.settle();
  assert.equal(f.state.recorded.id, 'receipt'); await f.state.acknowledgeRecorded(); await f.settle();
  f.context('first-floor', false); await f.settle(); f.context('first-floor'); await f.settle();
  f.state.setCustomerId('recipient'); await f.settle(); const next = f.state.submit();
  assert.notEqual(f.writes[1].body.idempotency_key, f.writes[0].body.idempotency_key);
  f.writes[1].resolve({ recipient_customer_name: 'Recipient' }); await next; await f.settle();
  assert.equal(f.closed, 2);
});

test('a failed refresh does not relabel a confirmed transfer as a failed write', async () => {
  const f = sheet(); await f.ready(); f.failRefresh(); const first = f.state.submit();
  f.writes[0].resolve({ recipient_customer_name: 'Recipient' }); await first; await f.settle();
  assert.equal(f.state.submitError, ''); assert.equal(f.state.uncertain, false); assert.equal(f.closed, 1);
  assert.match(f.notifications.find(row => row.kind === 'error').message, /Transfer recorded/);
});

test('unmount blocks late transfer completion callbacks and visible notifications', async () => {
  const f = sheet(); await f.ready(); const first = f.state.submit(); f.unmount();
  f.writes[0].resolve({ recipient_customer_name: 'Recipient' }); await first;
  assert.equal(f.closed, 0); assert.equal(f.refreshed, 0); assert.equal(f.notifications.length, 0);
});

test('a terminal receipt for removed customer history is acknowledged without a new transfer', async () => {
  const f = sheet(); await f.ready(); const first = f.state.submit();
  f.writes[0].reject({ status: 410, payload: { detail: { code: 'godown_transfer_record_removed', message: 'Customer history removed',
    transfer: { id: 'terminal-receipt', stock_id: 'stock', floor_id: 'first-floor', qty: 2, recipient_customer_name: 'Customer record removed' } } } });
  await first; await f.settle();
  assert.equal(f.state.recorded.id, 'terminal-receipt'); assert.equal(f.state.canSubmit, false);
  await f.state.acknowledgeRecorded(); await f.settle();
  assert.equal(f.writes.length, 1); assert.equal(f.closed, 1); assert.equal(f.refreshed, 1);
});
