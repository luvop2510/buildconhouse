import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
function tokens(file, require) {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require });
  return module.exports;
}
const design = tokens('src/design/tokens.ts', () => ({ StyleSheet: { create: x => x } }));
const theme = tokens('src/theme/tokens.ts', () => design);
for (const [value, expected] of [[0,'0'], [74300,'74,300'], [100000,'1.00 L'], [743000,'7.43 L'], [10000000,'1.00 Cr'], [-74300,'-74,300']]) {
  assert.equal(design.fmtMoneyCompact(value), expected);
  assert.equal(theme.moneyShort(value), `₹${expected}`);
}
assert.equal(theme.money(12345678.9), '₹1,23,45,678.90');
console.log('Indian amounts: full and compact prices keep rupees, lakh/crore grouping and negative signs.');
