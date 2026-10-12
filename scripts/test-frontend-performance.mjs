import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { roomProductQuantities, catalogProductQuantity } from '../src/components/quotation/helpers/catalogMetrics.ts';
import { hasMinimumPasswordLength } from '../src/utils/passwordPolicy.ts';

for (const password of ['123456', '12345678901', '😀'.repeat(6)]) assert.equal(hasMinimumPasswordLength(password), true);
for (const password of ['', '12345', '😀'.repeat(3)]) assert.equal(hasMinimumPasswordLength(password), false);

const lines = [
  { product_id: 'basin', room: 'Bathroom', qty: 2 },
  { product_id: 'white', room: 'Bathroom', qty: 3 },
  { product_id: 'white', room: 'Kitchen', qty: 9 },
  { product_id: 'white', room: 'Bathroom', qty: 1 },
];
const quantities = roomProductQuantities(lines, 'Bathroom');
assert.equal(catalogProductQuantity({ id: 'basin', variants: [{ id: 'white' }, { id: 'basin' }] }, quantities), 6);
assert.equal(catalogProductQuantity({ id: 'missing', variants: [] }, quantities), 0);
assert.equal(catalogProductQuantity({ id: 'white', variants: [{ id: 'white' }] }, quantities), 4);
assert.equal(roomProductQuantities(lines, 'empty').size, 0);

// Representative large customer quotation, with the real catalog scale. Check
// parity with the previous per-card scan and report before/after CPU evidence.
const products = Array.from({ length: 2600 }, (_, index) => ({ id: `product-${index}`, variants: [{ id: `finish-${index}` }] }));
const quotation = Array.from({ length: 500 }, (_, index) => ({ product_id: index % 2 ? `product-${index}` : `finish-${index}`, room: index % 3 ? 'Bathroom' : 'Kitchen', qty: index % 5 + 1 }));
const before = performance.now();
const oldResult = products.map(product => quotation.filter(line => line.room === 'Bathroom' && (line.product_id === product.id || product.variants.some(variant => variant.id === line.product_id))).reduce((sum, line) => sum + line.qty, 0));
const scanMs = performance.now() - before;
const after = performance.now();
const indexed = roomProductQuantities(quotation, 'Bathroom');
const newResult = products.map(product => catalogProductQuantity(product, indexed));
const indexedMs = performance.now() - after;
assert.deepEqual(newResult, oldResult);
console.log(`Room quantity computation: ${scanMs.toFixed(2)}ms repeated scan → ${indexedMs.toFixed(2)}ms index (${(scanMs / indexedMs).toFixed(1)}×); 2600 products / 500 lines.`);

const explorer = readFileSync(new URL('../src/components/quotation/catalog/ProductExplorer.tsx', import.meta.url), 'utf8');
assert.match(explorer, /onQuickAdd=\{b\.addFromProduct\}/);
assert.match(explorer, /onToggleFav=\{b\.toggleFavourite\}/);
assert.doesNotMatch(explorer, /b\.s\.lines\.filter/);
const followups = readFileSync(new URL('../app/(admin)/followups.tsx', import.meta.url), 'utf8');
const outcomes = followups.slice(followups.indexOf('const OUTCOMES:'), followups.indexOf('function CallOutcomeSheet'));
assert.doesNotMatch(outcomes, /value: "(?:won|converted)"/);
const detail = readFileSync(new URL('../app/(admin)/quotations/[id]/index.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(detail.slice(detail.indexOf('const NEXT_STATUS'), detail.indexOf('type PoStub')), /"won"/);
console.log('Frontend performance and confirmed-order contracts passed');
