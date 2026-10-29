import assert from 'node:assert/strict';
import { collectPagedExportRows as collectTileExportRows } from '../src/utils/pagedExcel.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const cellModule = { exports: {} };
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/tileOrdersExcel.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: cellModule.exports, require: () => ({ collectPagedExportRows: collectTileExportRows }) });
const { tileExportCells } = cellModule.exports;

const controller = new AbortController();
const reads = [], progress = [];
const rows = await collectTileExportRows(async page => {
  reads.push(page);
  return { rows: page === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }], total: 3, page, page_size: 2, has_more: page === 1, next_page: page === 1 ? 2 : null };
}, controller.signal, message => progress.push(message));
assert.deepEqual(reads, [1, 2]);
assert.equal(rows.length, 3);
assert.deepEqual(progress, ['Reading 2 of 3 rows…', 'Reading 3 of 3 rows…']);
const meta = { total: 1, page: 1, page_size: 100, has_more: false, next_page: null };
await assert.rejects(() => collectTileExportRows(async () => ({ ...meta, total: 5000, rows: [] }), controller.signal, () => {}), /4,999/);
await assert.rejects(() => collectTileExportRows(async () => ({ ...meta, rows: [] }), controller.signal, () => {}), /list changed/);
await assert.rejects(() => collectTileExportRows(async () => ({ ...meta, rows: [], has_more: true, next_page: 1 }), controller.signal, () => {}), /complete list/);
await assert.rejects(() => collectTileExportRows(async page => ({ ...meta, page, total: page === 1 ? 2 : 3, rows: [{ id: page }], has_more: page === 1, next_page: 2 }), controller.signal, () => {}), /list changed/);
const cancelled = new AbortController(); let cancelledReads = 0;
await assert.rejects(() => collectTileExportRows(async () => { cancelledReads++; cancelled.abort(); return { ...meta, rows: [{}] }; }, cancelled.signal, () => {}), /cancelled/);
assert.equal(cancelledReads, 1);
const cells = tileExportCells('dispatch-list', [{ customer_name: 'Customer', brand_name: 'Brand', tile_name: 'Tile', tile_size: '60x60', sku: 'SKU', boxes: 2, quantity_unit: 'Pieces', source: 'Godown', dispatch_number: 'DSP-1', dispatch_date: '2026-10-30', chalan_number: 'CH-1', vehicle_number: null, driver_name: null, status: 'Delivered', performed_by_name: 'Staff' }]);
assert.equal(cells[1][5], 2); assert.equal(cells[1][6], 'Pieces');
assert.equal(cells[0].length, cells[1].length);
console.log('Tile Excel: complete pagination, limits, changed datasets, cancellation and quantity units pass');

// Exercise the real button hook: repeated taps and ordinary rerenders keep one export alive.
const exports = {}, hooks = [], effects = [], downloads = [], messages = [];
let cursor = 0, tree, props, dirty = false;
const same = (a, b) => a?.length === b?.length && a?.every((value, index) => Object.is(value, b[index]));
const react = {
  useRef(value) { const slot = cursor++; return hooks[slot] ||= { current: value }; },
  useState(value) { const slot = cursor++; hooks[slot] ||= { value }; return [hooks[slot].value, next => { hooks[slot].value = next; dirty = true; }]; },
  useEffect(fn, deps) { const slot = cursor++; if (!same(hooks[slot]?.deps, deps)) { const previous = hooks[slot]; hooks[slot] = { deps }; effects.push(() => { previous?.cleanup?.(); hooks[slot].cleanup = fn(); }); } },
};
const jsx = (type, props) => ({ type, props });
const modules = {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { View: 'View' },
  '@/src/components/AppText': { Text: 'Text' }, '@/src/design/controls': { Button: 'Button' },
  '@/src/components/Toast': { toast: { success: message => messages.push(message), error: message => messages.push(message) } },
  '@/src/api/client': { beginIdentityOperation: () => ({ signal: new AbortController().signal, isCurrent: () => true, finish() {} }) },
  '@/src/state/auth': { useAuth: () => ({ staff: { id: 'owner', role: 'owner' } }) },
  '@/src/team-delegation': { hasGrantAccess: () => true },
  '@/src/utils/sectionExcel': { downloadSectionExcel: async value => { downloads.push(value); return true; } },
  '@/src/design/tokens': { color: {}, text: {} },
};
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/ExcelExportButton.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require: name => modules[name], AbortController });
function render() { cursor = 0; dirty = false; tree = exports.ExcelExportButton(props); effects.splice(0).forEach(fn => fn()); }
const button = () => tree.props.children[0].props;
async function settle() { for (let index = 0; index < 10; index++) { await Promise.resolve(); if (dirty) render(); } }
let readCount = 0, finishRead, sourceSignal;
const readRows = (signal) => { readCount++; sourceSignal = signal; return new Promise(resolve => { finishRead = resolve; }); };
props = { resource: 'orders', page: 'Tile Orders', section: 'Customer', filename: 'orders.xlsx', floorId: 'ground-floor', scopeKey: 'all', loadRows: readRows };
render();
button().onPress(); button().onPress(); await settle();
assert.equal(readCount, 1); assert.equal(button().label, 'Exporting…');
props = { ...props, loadRows: (signal) => readRows(signal) }; render();
assert.equal(sourceSignal.aborted, false, 'a new callback reference must not cancel the operation');
finishRead([['Customer'], ['A']]); await settle();
assert.equal(downloads.length, 1); assert.equal(button().label, 'Export Excel');
button().onPress(); await settle(); props = { ...props, scopeKey: 'new-filter' }; render();
assert.equal(sourceSignal.aborted, true, 'changing filters cancels the old export');
finishRead([['Customer'], ['Old filter']]); await settle(); assert.equal(downloads.length, 1);
button().onPress(); await settle(); hooks.forEach(hook => hook?.cleanup?.());
assert.equal(sourceSignal.aborted, true, 'unmount cancels the source read');
finishRead([['Customer'], ['Unmounted']]); await settle(); assert.equal(downloads.length, 1);
console.log('Excel button: repeated taps coalesce, callback rerenders stay live, filter changes and unmount reject stale exports');
