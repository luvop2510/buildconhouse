import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/tiles/tilePickerHistory.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, AbortController, setTimeout, clearTimeout });
const { tilePickerHistory } = exports;

test('available prior rates are retained', async () => {
  const rates = { found: true, rate_sqft: 85 };
  assert.equal(await tilePickerHistory(async () => rates, new AbortController().signal), rates);
});
test('a held history service releases selection at its budget and cancels its consumer', async () => {
  let readSignal;
  const result = await tilePickerHistory(signal => { readSignal = signal; return new Promise(() => {}); }, new AbortController().signal, 10);
  assert.equal(result, undefined);
  assert.equal(readSignal.aborted, true);
});
test('closing the picker releases a pending lookup without waiting for its deadline', async () => {
  const picker = new AbortController();
  let readSignal;
  const pending = tilePickerHistory(signal => { readSignal = signal; return new Promise(() => {}); }, picker.signal, 30_000);
  picker.abort();
  assert.equal(await pending, undefined);
  assert.equal(readSignal.aborted, true);
});
test('history failures and late replies cannot fail or change the selected product', async () => {
  assert.equal(await tilePickerHistory(async () => { throw new Error('offline'); }, new AbortController().signal), undefined);
  let reply;
  const pending = tilePickerHistory(() => new Promise(resolve => { reply = resolve; }), new AbortController().signal, 5);
  assert.equal(await pending, undefined);
  reply({ found: true, rate_sqft: 1 });
  assert.equal(await pending, undefined);
});
test('an already closed picker never starts history', async () => {
  const picker = new AbortController(); picker.abort();
  let reads = 0;
  assert.equal(await tilePickerHistory(async () => { reads++; }, picker.signal), undefined);
  assert.equal(reads, 0);
});

// Exercise the actual pick callback so duplicate taps and stale modal replies
// cannot pass solely because the optional-history helper is correct.
const pickerSource = readFileSync(new URL('../src/components/tiles/TilesProductPicker.tsx', import.meta.url), 'utf8');
const start = pickerSource.indexOf('  const pick = useCallback(');
const end = pickerSource.indexOf('\n  const loadMore =', start);
function picker({ history = new Promise(() => {}), sizeRead = history } = {}) {
  const selection = { current: null }, mounted = { current: true }, queryContext = { current: { open: true, customerId: 'customer' } };
  const calls = [], reads = [], exports = {};
  vm.runInNewContext(ts.transpileModule(pickerSource.slice(start, end) + '\nexport { pick };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, selection, mounted, queryContext, customerId: 'customer',
    setChoosing() {}, useCallback: callback => callback, AbortController,
    Haptics: { selectionAsync: async () => {} }, toast: { error: message => calls.push(['error', message]) },
    onPick: product => calls.push(['pick', product.id]), onClose: () => calls.push(['close']),
    tilePickerHistory: (read, signal) => tilePickerHistory(read, signal, 10),
    api: { get: (url, options) => { reads.push({ url, options }); return url.includes('size-variants') ? sizeRead : history; } },
  });
  return { ...exports, calls, reads, changeCustomer() { queryContext.current.customerId = 'other-customer'; }, close() { queryContext.current.open = false; selection.current?.abort(); selection.current = null; } };
}
test('rapid product taps result in exactly one added tile despite held optional history', async () => {
  const fixture = picker();
  await Promise.all([fixture.pick({ id: 'one' }), fixture.pick({ id: 'two' })]);
  assert.deepEqual(fixture.calls, [['pick', 'one'], ['close']]);
  assert.equal(fixture.reads.length, 1);
});
test('closing the picker cancels a held selection and never changes the document', async () => {
  const fixture = picker();
  const pending = fixture.pick({ id: 'one' }); fixture.close(); await pending;
  assert.deepEqual(fixture.calls, []);
});
test('late size resolution after close cannot add to another document', async () => {
  let resolve;
  const fixture = picker({ sizeRead: new Promise(yes => { resolve = yes; }) });
  const pending = fixture.pick({ id: 'one' }, '600x600'); fixture.close();
  resolve({ product: { id: 'sibling' } }); await pending;
  assert.deepEqual(fixture.calls, []);
});

test('customer changes invalidate prior-price completion before passive effects run', async () => {
  let resolve;
  const fixture = picker({ history: new Promise(yes => { resolve = yes; }) });
  const pending = fixture.pick({ id: 'one' }); fixture.changeCustomer();
  resolve({ found: true, rate_sqft: 85 }); await pending;
  assert.deepEqual(fixture.calls, []);
});
