import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(readFileSync('docs/audits/2026-10-06-inter-web-font-compression.json', 'utf8'));
const expected = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'Inter-Bold'];
const nativeMap = readFileSync('src/hooks/app-font-assets.ts', 'utf8');
const webMap = readFileSync('src/hooks/app-font-assets.web.ts', 'utf8');
assert.doesNotMatch(nativeMap, /\.woff2/);
assert.doesNotMatch(webMap, /\.ttf/);
for (const family of expected) {
  assert.ok(nativeMap.includes(`@/assets/fonts/${family}.ttf`));
  assert.ok(webMap.includes(`@/assets/fonts/${family}.woff2`));
}
assert.deepEqual(manifest.files.map(file => file.family), expected);
assert.equal(manifest.format.subsetting, false);
assert.deepEqual(manifest.unsupported_or_unequal_semantic_data, []);
let sourceBytes = 0;
let webBytes = 0;
for (const file of manifest.files) {
  for (const [kind, extension] of [['source', 'ttf'], ['web', 'woff2']]) {
    assert.equal(file[`${kind}_path`], `assets/fonts/${file.family}.${extension}`);
    const bytes = readFileSync(file[`${kind}_path`]);
    assert.equal(bytes.length, file[`${kind}_bytes`]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file[`${kind}_sha256`], `${file.family} ${kind} differs from its verified conversion`);
    if (kind === 'web') assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
  }
  assert.ok(file.glyph_count > 2900 && file.unicode_count > 2800);
  assert.ok(Object.keys(file.checks).length >= 20);
  assert.ok(Object.values(file.checks).every(value => value === true));
  sourceBytes += file.source_bytes;
  webBytes += file.web_bytes;
}
assert.equal(sourceBytes, manifest.source_total_bytes);
assert.equal(webBytes, manifest.web_total_bytes);
assert.ok(webBytes <= 576 * 1024, `Web text fonts exceed 576 KiB: ${webBytes}`);
console.log(`Verified four complete font assets: ${sourceBytes} native bytes, ${webBytes} web bytes (${(100 * (1 - webBytes / sourceBytes)).toFixed(2)}% reduction).`);
