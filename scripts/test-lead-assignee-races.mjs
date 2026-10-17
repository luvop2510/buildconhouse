import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/leads/LeadScopeFields.tsx', import.meta.url), 'utf8');
const instrumented = source.replace('  return <View', '  return { workers, error, loading };\n  return <View');
assert.notEqual(instrumented, source);
const compiled = ts.transpileModule(instrumented, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function fixture() {
  const hooks = [], effects = [], timers = [], requests = [], changes = [];
  let index = 0;
  const react = {
    useState(initial) {
      const slot = index++;
      hooks[slot] ||= { value: initial };
      return [hooks[slot].value, value => { hooks[slot].value = value; }];
    },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useEffect(callback, deps) {
      const slot = index++;
      if (!hooks[slot]?.deps?.every((value, i) => Object.is(value, deps[i]))) {
        const cleanup = hooks[slot]?.cleanup;
        hooks[slot] = { deps };
        effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
      }
    },
  };
  const modules = {
    react,
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ floors: [] }) },
    '@/src/api/leads': { leadsApi: { assignees: (...args) => new Promise(resolve => requests.push({ args, resolve })) } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, setTimeout: callback => (timers.push(callback), callback), clearTimeout: () => {} });
  const render = (value, extra = {}, flush = true) => {
    index = 0;
    const state = exports.LeadScopeFields({ value, onChange: value => changes.push(value), ...extra });
    if (flush) while (effects.length) effects.shift()();
    return state;
  };
  return { render, requests, changes, start: () => timers.shift()(), async settle() { for (let n = 0; n < 5; n++) await Promise.resolve(); } };
}
const old = { interested_floor_ids: ['first-floor'], assignments: [{ floor_id: 'first-floor', user_id: 'old-owner' }], reference_source: 'Initial reference', referrer_id: 'old-partner' };
const worker = { id: 'employee', full_name: 'Employee', floor_ids: ['first-floor'] };

test('delayed worker eligibility removes invalid assignments while preserving the latest reference edits', async () => {
  const view = fixture();
  view.render(old); view.start();
  const edited = { ...old, reference_source: 'Updated reference', referrer_id: 'new-partner' };
  view.render(edited);
  view.requests[0].resolve([worker]); await view.settle();
  assert.equal(view.changes.length, 1);
  assert.equal(view.changes[0].reference_source, 'Updated reference');
  assert.equal(view.changes[0].referrer_id, 'new-partner');
  assert.deepEqual(Array.from(view.changes[0].assignments), []);
});

test('eligibility from the prior floor cannot reconcile a new floor before passive cleanup runs', async () => {
  const view = fixture();
  view.render(old); view.start();
  view.render({ ...old, interested_floor_ids: ['third-floor'] }, {}, false);
  view.requests[0].resolve([worker]); await view.settle();
  assert.equal(view.changes.length, 0);
});

test('eligibility from the prior customer cannot remove new customer selections', async () => {
  const view = fixture();
  view.render(old, { customerId: 'old-customer' }); view.start();
  view.render({ ...old, assignments: [{ floor_id: 'first-floor', user_id: 'new-worker' }] }, { customerId: 'new-customer' }, false);
  view.requests[0].resolve([worker]); await view.settle();
  assert.equal(view.changes.length, 0);
});
