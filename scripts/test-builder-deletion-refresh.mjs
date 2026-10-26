import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/quotation/context/BuilderContext.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('BuilderContext.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = [];
const visit = node => {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useFocusEffect') {
    const callback = node.arguments[0].arguments[0];
    callbacks.push(callback.getText(tree));
  }
  ts.forEachChild(node, visit);
};
visit(tree);

function fixture(kind) {
  const body = callbacks.find(callback => callback.includes(kind === 'recent' ? '/quotations/recent' : 'setCustomers(cs)'));
  assert.ok(body, `${kind} must reload when the mounted builder regains navigation focus`);
  const exports = {}, requests = [], timers = new Map();
  let customers = [], recent = [{ id: 'deleted' }], timerId = 0;
  const pending = (path, options) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    options.signal.addEventListener('abort', () => reject({ name: 'AbortError' }), { once: true });
    requests.push({ path, options, resolve });
    return promise;
  };
  vm.runInNewContext(ts.transpileModule(`exports.focus = ${body}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, AbortController, activeFloorId: 'first-floor',
    api: { get: pending },
    setRecentQuotations: value => { recent = value; },
    setCustomers: value => { customers = value; },
    setReferenceLoading() {}, setReferenceError() {}, setCategories() {}, setBrands() {}, setCategoriesForRail() {},
    catalogReferences: { categories: () => Promise.resolve([]), brands: () => Promise.resolve([]) },
    retryReferenceData() {}, Platform: { OS: 'native' }, console,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { requests, focus: exports.focus, get recent() { return recent; }, get customers() { return customers; },
    fire() { const pending = [...timers.values()]; timers.clear(); pending.forEach(run => run()); },
    async settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); } };
}

test('returning to the builder clears deleted Recent rows and re-reads without the pre-deletion cache', async () => {
  const f = fixture('recent');
  const blur = f.focus(); f.fire();
  f.requests[0].resolve([{ id: 'before-delete' }]); await f.settle();
  assert.equal(f.recent[0].id, 'before-delete');
  blur();
  const nextBlur = f.focus();
  assert.equal(f.recent.length, 0, 'Old records must not remain visible during refresh');
  f.fire();
  assert.equal(f.requests[1].options.cacheMs, 0);
  assert.equal(f.requests[1].options.floorId, 'first-floor');
  f.requests[1].resolve([]); await f.settle();
  assert.equal(f.recent.length, 0);
  nextBlur();
});

test('returning from customer deletion refreshes the customer picker and ignores blurred requests', async () => {
  const f = fixture('customers');
  const blur = f.focus();
  assert.equal(f.requests[0].options.cacheMs, 0);
  f.requests[0].resolve([{ id: 'buyer' }]); await f.settle();
  assert.equal(f.customers[0].id, 'buyer');
  blur();
  const nextBlur = f.focus();
  f.requests[1].resolve([]); await f.settle();
  assert.equal(f.customers.length, 0);
  nextBlur();
  const lastBlur = f.focus();
  lastBlur();
  f.requests[2].resolve([{ id: 'late-deleted-buyer' }]); await f.settle();
  assert.equal(f.customers.length, 0);
});
