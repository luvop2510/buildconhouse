import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/components/kitchen/KitchenAutosave.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const hooks = [], effects = [], timers = new Map(), writes = [], errors = [];
  let index = 0, timerId = 0, result, settle, mounted = true;
  const state = { drafts: { field: true }, submission: { busy: false, setError: message => errors.push(message) } };
  let props = { draftKey: 'field', value: 'draft', saved: 'saved', enabled: true, save() {
    writes.push(props.value); state.submission.busy = true;
    return new Promise(resolve => { settle = accepted => { state.submission.busy = false; resolve(accepted); }; });
  } };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, position) => Object.is(value, b[position]));
  const react = {
    useRef(value) { return hooks[index++] ||= { current: value }; },
    useState(value) { const slot = index++; hooks[slot] ||= { value }; return [hooks[slot].value, next => { assert.ok(mounted, 'Unmounted hooks cannot publish'); hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next; }]; },
    useEffect(effect, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const old = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { old?.(); hooks[slot].cleanup = effect(); }); } },
  };
  const exports = {};
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', compiled)(name => name === 'react' ? react : { useKitchenProject: () => state }, exports,
    fn => { const id = ++timerId; timers.set(id, fn); return id; }, id => timers.delete(id));
  function render(next = {}) { props = { ...props, ...next }; index = 0; result = exports.useKitchenAutosave(props); while (effects.length) effects.shift()(); return result; }
  return { render, writes, state, errors, get result() { return result; }, get timers() { return timers.size; },
    async fire() { const ready = [...timers.values()]; timers.clear(); for (const run of ready) { void run(); } await Promise.resolve(); return render(); },
    async settle(accepted, saved) { if (saved !== undefined) props.saved = saved; settle(accepted); for (let n = 0; n < 4; n++) await Promise.resolve(); return mounted ? render() : result; },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); mounted = false; },
  };
}
const debounce = harness();
assert.equal(debounce.render().status, 'pending');
debounce.render({ value: 'first' }); debounce.render({ value: 'latest' });
assert.equal(debounce.timers, 1, 'Successive keystrokes coalesce');
await debounce.fire(); assert.deepEqual(debounce.writes, ['latest']);
assert.equal(debounce.result.status, 'saving');
debounce.render({ value: 'newer while pending' });
await debounce.settle(true, 'latest');
assert.equal(debounce.result.status, 'pending', 'The response cannot certify newer typing');
await debounce.fire(); assert.deepEqual(debounce.writes, ['latest', 'newer while pending']);
await debounce.settle(true, 'newer while pending');
assert.equal(debounce.result.status, 'saved');
assert.equal(debounce.timers, 0);
const failure = harness(); failure.render(); await failure.fire(); await failure.settle(false);
assert.equal(failure.result.status, 'failed'); assert.equal(failure.timers, 0, 'Failure does not cause retry loops');
failure.result.retry(); failure.render(); assert.equal(failure.timers, 1); await failure.fire();
assert.equal(failure.writes.length, 2); await failure.settle(true);
assert.equal(failure.result.status, 'pending', 'No Saved claim until server values match');
failure.render({ saved: 'draft' }); assert.equal(failure.result.status, 'saved');
const disabled = harness(); disabled.render({ enabled: false }); assert.equal(disabled.timers, 0, 'Consequential/stale drafts cannot autosubmit');
disabled.render({ enabled: true }); disabled.state.submission.busy = true; disabled.render(); await disabled.fire();
assert.equal(disabled.writes.length, 0, 'Busy admission is checked again at timer execution');
disabled.state.submission.busy = false; disabled.render(); await disabled.fire(); assert.equal(disabled.writes.length, 1);
const untouched = harness(); untouched.state.drafts = {}; untouched.render(); assert.equal(untouched.timers, 0, 'Untouched defaults cannot create writes'); assert.equal(untouched.result.status, 'pending', 'Displayed defaults that differ from the server are never called saved');
const unmounted = harness(); unmounted.render(); await unmounted.fire(); unmounted.unmount();
await unmounted.settle(true, 'draft');
const switched = harness(); switched.render(); await switched.fire();
switched.state.drafts.other = true; switched.render({ draftKey: 'other', value: 'other draft' }); await switched.settle(false);
assert.notEqual(switched.result.status, 'failed', 'Another draft cannot inherit the old save error');
const exception = harness(); exception.render({ save: async () => { throw Error('Unexpected rejection'); } }); await exception.fire();
await Promise.resolve(); exception.render(); assert.equal(exception.result.status, 'failed'); assert.equal(exception.errors.length, 1);
console.log('Kitchen autosave debounce, admission, newer edits, failure/retry, truthful Saved, scope and unmount checks passed.');
