import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/components/kitchen/KitchenDates.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function('exports', compiled)(exports);
for (const [timestamp, expected] of [
  ['2026-10-22T18:29:59Z', '2026-10-22'],
  ['2026-10-22T18:30:00Z', '2026-10-23'],
  ['2026-12-31T20:00:00Z', '2027-01-01'],
  ['2028-02-28T20:00:00Z', '2028-02-29'],
]) assert.equal(exports.kitchenToday(new Date(timestamp)), expected, timestamp);
console.log('Kitchen date defaults: India midnight, year boundary and leap day passed');
