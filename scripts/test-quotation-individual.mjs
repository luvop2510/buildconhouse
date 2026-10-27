import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, dependencies = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => { assert.ok(dependencies[name], `Unexpected dependency ${name}`); return dependencies[name]; } });
  return exports;
}
const totals = load('../src/components/quotation/helpers/totals.ts');
const pricing = load('../src/components/quotation/helpers/pricing.ts', { './totals': totals });
const line = (id, room, unit_price, extra = {}) => ({ id, room, unit_price, qty: 1, discount_pct: null, category_id: 'basins', ...extra });
const lines = [
  line('parent', 'Bath', 100, { qty: 3, discount_pct: 20, area: 'Existing area' }),
  line('included', 'Bath', 0, { qty: 3, included_for_line_id: 'parent' }),
  line('other-bath', 'Bath', 200),
  line('kitchen', 'Kitchen', 100),
];
const room = { Bath: { type: 'amount', value: 50 } };
const categories = { basins: 10 };
const rows = pricing.computeLineBreakdown(lines, 5, categories, room);
const byId = Object.fromEntries(rows.map(row => [row.line.id, row]));
assert.equal(byId.parent.net, 240, 'product override beats room flat discount');
assert.equal(byId['other-bath'].net, 150, 'room flat discount is allocated to eligible rows');
assert.equal(byId.kitchen.net, 90, 'category beats project discount');
assert.equal(rows.reduce((sum, row) => sum + row.net, 0), pricing.computeTotals(lines, 5, categories, room).grand);
assert.equal(pricing.computeTotals(lines, 5, categories, room).grand, 480);
assert.equal(pricing.computeTotals(lines, 5, categories, { Bath: { type: 'amount', value: 9999 } }).grand, 330, 'flat discount is capped and leaves overrides alone');

const filters = load('../src/components/quotation/helpers/catalogFilters.ts');
assert.equal(filters.restoreSingleCatalogChoice(['grohe', 'hansgrohe'], 'legacy'), 'grohe');
assert.equal(filters.restoreSingleCatalogChoice([null, '', 2, 'basins', 'showers'], null), 'basins');
assert.equal(filters.restoreSingleCatalogChoice([], 'legacy'), null, 'explicit all selection takes precedence over old scalar state');
assert.equal(filters.restoreSingleCatalogChoice(undefined, 'legacy'), 'legacy');
assert.equal(filters.restoreSingleCatalogChoice(undefined, 5), null);

// Guard the confirmed expensive rendering pattern and obsolete batch API.
const rowSource = readFileSync(new URL('../src/components/quotation/canvas/LineRow.tsx', import.meta.url), 'utf8');
const contextSource = readFileSync(new URL('../src/components/quotation/context/BuilderContext.tsx', import.meta.url), 'utf8');
const paneSource = readFileSync(new URL('../src/components/quotation/panes/QuotationPane.tsx', import.meta.url), 'utf8');
assert.match(rowSource, /b\.lineBreakdownById\[l\.id\]/);
assert.doesNotMatch(rowSource, /computeLineBreakdown/);
assert.doesNotMatch(contextSource, /assignAreaToLines/);
assert.doesNotMatch(paneSource, /AreaGrouping/);
console.log('Quotation individual editing: pricing, bounded row calculations and single-choice legacy filter restoration passed');

if (process.argv.includes('--benchmark')) {
  const sample = Array.from({ length: 500 }, (_, index) => line(`line-${index}`, `Room ${index % 4}`, 100 + index, { qty: (index % 3) + 1 }));
  const discounts = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`Room ${i}`, { type: 'amount', value: 75 }]));
  const oldRender = () => sample.map(line => pricing.computeLineBreakdown(sample, 5, categories, discounts).find(row => row.line.id === line.id).net);
  const newRender = () => {
    const indexed = Object.fromEntries(pricing.computeLineBreakdown(sample, 5, categories, discounts).map(row => [row.line.id, row]));
    return sample.map(line => indexed[line.id].net);
  };
  assert.deepEqual(newRender(), oldRender());
  oldRender(); newRender();
  const measure = run => {
    const durations = Array.from({ length: 9 }, () => { const start = performance.now(); run(); return performance.now() - start; }).sort((a, b) => a - b);
    return { median_ms: durations[4], min_ms: durations[0], max_ms: durations[8] };
  };
  const before = measure(oldRender), after = measure(newRender);
  console.log(JSON.stringify({ kind: 'pricing calculation microbenchmark, not browser render duration', dataset: 'same 500 fixture lines, four rooms, category and flat room discounts', runs: 9, before, after, speedup: before.median_ms / after.median_ms }, null, 2));
}
