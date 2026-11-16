import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const exports = {};
const source = readFileSync(new URL('../src/components/tiles/tileProductName.ts', import.meta.url), 'utf8');
new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports);
for (const [name, size, expected] of [
  ['21836 (218X52)', '218X52', '21836'],
  ['DELICATO GREY - Matt (1200X1800)', '1200X1800', 'DELICATO GREY - Matt'],
  ['SQ 10 (60 × 300)', '60X300', 'SQ 10'],
  ['Model (Outdoor) [600x600] - Matt', '600X600', 'Model (Outdoor) - Matt'],
  ['Model 600x600', '600 X 600', 'Model'],
  ['Code218X52', '218X52', 'Code218X52'],
  ['Model (Series 218X52)', '218X52', 'Model (Series 218X52)'],
  ['Model (600X1200)', '600X600', 'Model (600X1200)'],
  ['Model (600X600)', '', 'Model (600X600)'],
  ['Editing a product name ', '600X600', 'Editing a product name '],
]) assert.equal(exports.tileProductName(name, size), expected);
const builder = readFileSync(new URL('../src/components/tiles/TilesDocBuilder.tsx', import.meta.url), 'utf8');
assert.equal((builder.match(/value=\{tileProductName\(row.name, row.size\)\}/g) || []).length, 2, 'Both shared desktop cells and mobile rows use the display projection');
assert.ok(builder.includes('sku: row.sku, name: row.name.trim()'), 'Saving retains the actual name instead of rewriting product data on load');
console.log('Product detail names retain codes/finishes and remove only the separately displayed size on desktop/mobile; stored names stay intact.');
