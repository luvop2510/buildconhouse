import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/components/ProductImage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ProductImage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['transformWidth', 'r2SizedImageUrl'].includes(node.name?.text));
const exports = {};
vm.runInNewContext(ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, URL });
const base = 'https://forge-media.yashvardhansinh2510.workers.dev/brand/a%20b.png';
for (const [width, expected] of [[160,320],[321,640],[641,1024],[1500,1600],[3000,2048]]) {
  const transformed = new URL(exports.r2SizedImageUrl(base, width));
  assert.equal(transformed.searchParams.get('width'), String(expected));
  assert.equal(transformed.pathname, new URL(base).pathname);
}
for (const url of ['data:image/png;base64,AA', 'https://supplier.example/a.png', base + '?signature=private', base + '#fragment', base.replace('https:', 'http:'), base.replace('/brand/', '/_image_variants/')]) {
  assert.equal(exports.r2SizedImageUrl(url, 320), null, 'Only configured unsigned public R2 originals are transformed');
}
assert.match(source, /preferOriginal \? \[uri, sized\] : \[sized, uri\]/, 'Zoom retains original-first source ordering');
console.log('R2 public derivative URLs retain source identity and bounded physical widths.');
