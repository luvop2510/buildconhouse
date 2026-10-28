import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/catalogService.ts', import.meta.url), 'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}), URLSearchParams });
assert.equal(exports.CATALOG_PAGE_SIZE, 50, "Catalog and quotation picker request at most 50 rows by default");
const { mergeCatalogPage, catalogItemKey, catalogGridRows, catalogPageProgress } = exports;
const family = { family_key: 'supplier-family', sample_product_id: 'a', floor_id: 'first-floor', brand_id: 'brand-a', category_id: 'basins' };
const siblings = [
  { ...family, category_id: 'faucets', sample_product_id: 'b' },
  { ...family, brand_id: 'brand-b', sample_product_id: 'c' },
  { ...family, floor_id: 'ground-floor', sample_product_id: 'd' },
];
const merged = mergeCatalogPage([family], [...siblings, family]);
assert.equal(merged.length, 4, 'Pagination must retain every floor/brand/category family');
assert.equal(new Set(merged.map(catalogItemKey)).size, 4, 'Rendered cards need distinct stable keys');
assert.equal(mergeCatalogPage(merged, [...siblings, family]).length, 4, 'Repeated pages must not duplicate cards');
assert.equal(catalogItemKey(family), catalogItemKey({ ...family, sample_product_id: 'different-representative' }), 'Family identity survives a representative change');
assert.notEqual(catalogItemKey({ ...family, category_id: 'a:b', brand_id: 'c' }), catalogItemKey({ ...family, category_id: 'b', brand_id: 'c:a' }), 'Identifiers cannot collide through delimiters');
const occurrences = [{ id: 'a', listing_id: 'row-1' }, { id: 'a', listing_id: 'row-2' }];
assert.equal(mergeCatalogPage([], [...occurrences, occurrences[0]]).length, 2, 'Distinct supplier occurrences survive canonical SKU deduplication');
assert.equal(mergeCatalogPage([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]).length, 2);
assert.notEqual(catalogItemKey({ ...family, family_key: null }), catalogItemKey({ ...family, family_key: null, sample_product_id: 'b' }), 'Ungrouped products stay distinct');
assert.notEqual(catalogItemKey({ ...family, family_key: 'a' }), catalogItemKey({ ...family, family_key: null }), 'A supplier family cannot collide with an ungrouped product ID');
const builder = readFileSync(new URL('../src/components/quotation/context/BuilderContext.tsx', import.meta.url), 'utf8');
const builderAst = ts.createSourceFile('BuilderContext.tsx', builder, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let append;
const visit = node => {
  if (ts.isCallExpression(node) && node.expression.getText(builderAst) === 'setProducts' &&
      ts.isArrowFunction(node.arguments[0]) && node.arguments[0].parameters[0]?.name.getText(builderAst) === 'cur' &&
      node.getText(builderAst).includes('items')) append = node.getText(builderAst);
  ts.forEachChild(node, visit);
};
visit(builderAst);
assert.ok(append, 'Quotation builder exposes its page append callback');
let quotationProducts;
vm.runInNewContext(append, {
  mergeCatalogPage, items: [occurrences[1], occurrences[0]],
  setProducts: update => { quotationProducts = update([occurrences[0]]); },
});
assert.equal(quotationProducts.length, 2, 'Quotation pagination retains both category listings of the same product');
const explorer = readFileSync(new URL('../src/components/quotation/catalog/ProductExplorer.tsx', import.meta.url), 'utf8');
assert.match(explorer, /keyExtractor=\{catalogItemKey\}/, 'Quotation cards use the same occurrence identity as pagination');
console.log('Catalog pagination, repeated pages, family identity and supplier occurrence regressions passed');

for (const columns of [1, 2, 3, 4, 5, 6]) {
  const rows = catalogGridRows(columns, 20);
  assert.ok(rows * columns >= 20, 'Initial working set covers the requested card budget');
  assert.ok(rows * columns < 20 + columns, 'Wide grids cannot multiply the card budget');
}
assert.equal(catalogGridRows(0, 0), 1);
assert.deepEqual(JSON.parse(JSON.stringify(catalogPageProgress(60, 60, 6500))), { nextSkip: 120, hasMore: true });
assert.deepEqual(JSON.parse(JSON.stringify(catalogPageProgress(60, 0, 6500))), { nextSkip: 60, hasMore: false });
assert.deepEqual(JSON.parse(JSON.stringify(catalogPageProgress(60, 10, 70))), { nextSkip: 70, hasMore: false });


// Execute the actual builder append callback, including its family adapter.
// Dropped families and duplicate occurrences must still consume server rows.
let adapterNode;
const findAdapter = node => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'familyCardToProduct') adapterNode = node;
  ts.forEachChild(node, findAdapter);
};
findAdapter(builderAst);
const callbackStart = builder.indexOf('  const loadMoreProducts = useCallback(');
const callbackEnd = builder.indexOf('  // ---------- Autosave ----------', callbackStart);
const callbackCode = ts.transpileModule(adapterNode.getText(builderAst) + '\n' + builder.slice(callbackStart, callbackEnd) + '\nglobalThis.append = loadMoreProducts;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let shown = [{ id: 'a', listing_id: 'row-1' }], more = true;
const reads = [], offset = { current: 60 }, loading = { current: false };
const context = {
  useCallback: fn => fn, catalogPageProgress, mergeCatalogPage, AbortController,
  productMounted: { current: true }, productQueryScope: 'current', currentProductScope: { current: 'current' },
  nextProductOffset: offset, productRequestGeneration: { current: 1 },
  loadMoreController: { current: null }, loadingMoreRef: loading,
  productLoading: false, productHasMore: true, q: '', selectedBrandIds: [], selectedCategoryIds: [], selectedSizes: [], sortKey: 'popular', activeFloorId: 'first-floor', CATALOG_PAGE_SIZE: exports.CATALOG_PAGE_SIZE,
  fetchCatalogPage: (_query, skip) => new Promise(resolve => reads.push({ skip, resolve })),
  setProducts: update => { shown = update(shown); },
  setProductTotal: () => {}, setProductLoadingMore: () => {}, setProductHasMore: value => { more = value; },
  console,
};
vm.createContext(context); vm.runInContext(callbackCode, context);
context.append();
assert.equal(reads[0].skip, 60);
reads[0].resolve({ total: 100, items: [
  { ...family, listing_id: 'row-1', variants: [{ id: 'a', sku: 'A' }] },
  { ...family, listing_id: 'row-2', variants: [{ id: 'a', sku: 'A' }] },
  { ...family, variants: [] },
] });
for (let i = 0; i < 10; i++) await Promise.resolve();
assert.equal(offset.current, 63, 'Builder consumes duplicate and non-displayable family rows');
assert.equal(shown.length, 2, 'Builder retains distinct occurrences and removes overlap');
context.append();
assert.equal(reads[1].skip, 63, 'Builder does not request the duplicate cursor again');
reads[1].resolve({ total: 100, items: [] });
for (let i = 0; i < 10; i++) await Promise.resolve();
assert.equal(more, false, 'Builder terminates empty-page infinite scrolling');
console.log('Actual builder pagination callback advances overlap/dropped rows and stops empty pages');

const readsBeforeStale = reads.length;
context.currentProductScope.current = 'next-floor';
context.append();
assert.equal(reads.length, readsBeforeStale, 'Builder rejects a retained callback from another query/floor');
context.currentProductScope.current = 'current';
context.productMounted.current = false;
context.append();
assert.equal(reads.length, readsBeforeStale, 'Builder rejects scroll callbacks after unmount');
