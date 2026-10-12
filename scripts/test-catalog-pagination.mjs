import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/catalogService.ts', import.meta.url), 'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => ({}), URLSearchParams });
const { mergeCatalogPage, catalogItemKey } = exports;
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
console.log('Catalog pagination, repeated pages, family identity and supplier occurrence regressions passed');
