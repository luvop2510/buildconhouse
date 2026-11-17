import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const durable = new Map();
let key = 0;
function harness(actorId = 'owner', options = {}) {
  const hooks = [], calls = [], effects = [];
  let cursor = 0, outcome = async () => { throw Object.assign(Error('Response interrupted'), { status: 503 }); };
  const module = { exports: {} };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  new Function('require', 'exports', ts.transpileModule(readFileSync('src/components/kitchen/KitchenLeadSubmission.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(name => name === 'react' ? {
    useRef: initial => { const slot = cursor++; return hooks[slot] ||= { current: initial }; },
    useState: initial => { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = initial; return [hooks[slot], value => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; }]; },
    useEffect: (work, deps) => { const slot = cursor++; if (!hooks[slot] || deps.some((value, i) => value !== hooks[slot].deps[i])) { hooks[slot]?.cleanup?.(); hooks[slot] = { deps }; effects.push(() => { hooks[slot].cleanup = work(); }); } },
  } : name === './shared' ? { errorText: error => error.message } : name.endsWith('floors') ? { KITCHEN_FLOOR_ID: 'second-floor' } : name === './KitchenLeadRecovery' ? {
    readKitchenLeadRecovery: async actor => { if (options.readFailure) throw Error('Unreadable storage'); return structuredClone(durable.get(actor) || null); },
    writeKitchenLeadRecovery: async row => { if (options.writeFailure) throw Error('Storage unavailable'); durable.set(row.actorId, structuredClone(row)); },
    removeKitchenLeadRecovery: async actor => { durable.delete(actor); },
  } : {
    kitchenCreateOutcomeUncertain: error => error.name === 'AbortError' || error.status === 408 || error.status >= 500,
    kitchenRequestKey: () => `operation-${actorId}-${++key}`,
    kitchenProjectsApi: { create: async (body, retry) => { calls.push({ body, retry }); return outcome(body, retry); } },
  }, module.exports);
  const render = () => { cursor = 0; const result = module.exports.useKitchenLeadSubmission(actorId); while (effects.length) effects.shift()(); return result; };
  return { calls, render, flush, setOutcome: work => { outcome = work; }, unmount: () => { for (const hook of hooks) hook?.cleanup?.(); } };
}
const draft = { customer: { name: 'Synthetic original', phone: '9001112223', address: 'Test address' }, lead: { status: 'New' } };
const h = harness();
assert.equal(h.render().ready, false);
assert.equal(await h.render().submit(draft, () => assert.fail()), false, 'New intake cannot start before durable recovery loads');
await h.flush(); let state = h.render(); assert.equal(state.ready, true);
let release;
h.setOutcome(() => new Promise((_resolve, reject) => { release = () => reject(Object.assign(Error('Interrupted'), { status: 503 })); }));
const first = state.submit(draft, () => assert.fail('Failure cannot report success'));
assert.equal(await state.submit(draft, () => assert.fail()), false);
await h.flush(); assert.equal(h.calls.length, 1);
assert.equal(h.render().busy, true);
assert.equal(durable.get('owner').body.idempotency_key, h.calls[0].body.idempotency_key, 'Exact body/key is durable before POST');
release(); await first;
state = h.render(); assert.equal(state.busy, false); assert.equal(state.uncertain, true); assert.match(state.error, /entries have been kept/);
state.reset(); assert.equal(h.render().uncertain, true);
assert.equal(await state.submit({ ...draft, lead: { status: 'Contacted' } }, () => assert.fail()), false);
assert.equal(h.calls.length, 1);
h.unmount();
const reload = harness(); reload.render(); await reload.flush();
state = reload.render(); assert.equal(state.uncertain, true); assert.equal(state.restored.body.idempotency_key, h.calls[0].body.idempotency_key);
reload.setOutcome(async () => { throw Object.assign(Error('Status permission unavailable'), { status: 403 }); });
await state.submit(draft, () => assert.fail());
assert.equal(reload.render().uncertain, true); assert.equal(reload.render().busy, false);
assert.equal(reload.calls[0].retry, true); assert.deepEqual(reload.calls[0].body, h.calls[0].body);
const other = harness('other-owner'); other.render(); await other.flush(); assert.equal(other.render().restored, null, 'Other accounts cannot inherit a recovery entry');
const saved = { id: 'saved-project' }; let success;
reload.setOutcome(async () => saved);
await reload.render().submit(draft, () => { throw Error('Router failed'); });
assert.equal(reload.render().confirmed, true); assert.equal(reload.render().busy, false); assert.ok(durable.has('owner'));
const callsBeforeNavigationRetry = reload.calls.length;
await reload.render().submit(draft, project => { success = project; });
assert.equal(success, saved); assert.equal(reload.calls.length, callsBeforeNavigationRetry, 'A failed success callback retries navigation without another POST or lookup');
assert.equal(durable.has('owner'), false, 'Confirmed handled results clear durable recovery');
await reload.render().submit(draft, () => {});
assert.notEqual(reload.calls.at(-1).body.idempotency_key, h.calls[0].body.idempotency_key);
const validation = harness('validation'); validation.render(); await validation.flush();
validation.setOutcome(async () => { throw Object.assign(Error('Phone invalid'), { status: 422 }); });
await validation.render().submit(draft, () => assert.fail());
assert.equal(validation.render().uncertain, false); assert.equal(durable.get('validation').outcome, 'rejected');
await validation.render().submit(draft, () => {});
assert.equal(validation.calls.at(-1).retry, false, 'Definitive validation retry does not perform an unnecessary status read');
await validation.render().submit({ ...draft, customer: { ...draft.customer, phone: '9001112224' } }, () => {});
assert.notEqual(validation.calls[0].body.idempotency_key, validation.calls.at(-1).body.idempotency_key);
const unavailable = harness('blocked', { readFailure: true }); unavailable.render(); await unavailable.flush();
assert.equal(unavailable.render().ready, false); await unavailable.render().submit(draft, () => assert.fail()); assert.equal(unavailable.calls.length, 0);
const writeBlocked = harness('write-blocked', { writeFailure: true }); writeBlocked.render(); await writeBlocked.flush();
await writeBlocked.render().submit(draft, () => assert.fail()); assert.equal(writeBlocked.calls.length, 0); assert.equal(writeBlocked.render().uncertain, false);
const leave = harness('left'); leave.render(); await leave.flush(); let late;
leave.setOutcome(() => new Promise(resolve => { late = resolve; }));
const pending = leave.render().submit(draft, () => assert.fail('An unmounted account cannot navigate')); await leave.flush(); leave.unmount(); late(saved); await pending;
assert.ok(durable.has('left'), 'An unmounted successful response retains recoverable operation identity');
console.log('Kitchen lead submission: durable exact operation before POST, reload/actor isolation, fail-closed storage, same-key retries, validation editing, confirmed navigation retry and unmount guards passed.');
