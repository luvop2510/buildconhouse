import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/utils/appendImageUpload.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function helper({ platform = 'web', input, decoded = true, outputs = [], width = 4800, height = 3200 } = {}) {
  const module = { exports: {} }, calls = [], revoked = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => calls.push(['draw', ...args]),
    fillStyle: '', fillRect: (...args) => calls.push(['fill', ...args]) }),
    toBlob: (resolve, type, quality) => { calls.push(['encode', type, quality]); resolve(outputs.shift() || null); } };
  vm.runInNewContext(code, { module, exports: module.exports, Blob,
    require: name => name === 'react-native' ? { Platform: { OS: platform } } : { uriToBlob: async uri => { calls.push(['fetch', uri]); return input; } },
    URL: { createObjectURL: () => { calls.push(['createURL']); return 'blob:fixture'; }, revokeObjectURL: url => revoked.push(url) },
    Image: class { naturalWidth = width; naturalHeight = height; set src(_url) { queueMicrotask(() => decoded ? this.onload() : this.onerror()); } },
    document: { createElement: () => canvas },
  });
  return { ...module.exports, calls, revoked, canvas };
}
const small = new Blob(['photo'], { type: 'image/png' });
{
  const image = helper();
  assert.equal(await image.prepareWebPhoto(small), small, 'small originals remain byte-identical');
  assert.deepEqual(image.calls, []);
}
{
  const large = new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: 'image/png' });
  const compressed = new Blob(['alpha-preserved'], { type: 'image/webp' });
  const image = helper({ outputs: [compressed] });
  assert.equal(await image.prepareWebPhoto(large), compressed);
  assert.equal(image.canvas.width, 2400); assert.equal(image.canvas.height, 1600);
  assert.equal(image.calls.find(call => call[0] === 'encode')[1], 'image/webp');
  assert.equal(image.calls.some(call => call[0] === 'fill'), false, 'transparent photos keep alpha with WebP');
  assert.deepEqual(image.revoked, ['blob:fixture']);
}
{
  const heic = new Blob(['phone-photo'], { type: 'image/heic' });
  const compressed = new Blob(['browser-decoded-jpeg'], { type: 'image/jpeg' });
  const image = helper({ outputs: [compressed], width: 1200, height: 1800 });
  assert.equal(await image.prepareWebPhoto(heic), compressed, 'browser-decodable camera format converts to accepted MIME');
  assert.equal(image.canvas.width, 1200); assert.equal(image.canvas.height, 1800, 'portrait orientation is retained');
  assert.ok(image.calls.some(call => call[0] === 'fill'), 'JPEG alpha fallback has a neutral background');
}
{
  const image = helper({ decoded: false });
  await assert.rejects(image.prepareWebPhoto(new Blob(['unreadable'], { type: 'image/heic' })), /Choose a JPG, PNG or WebP/);
  assert.deepEqual(image.revoked, ['blob:fixture'], 'failed decoder releases object URL');
}
{
  const large = new Blob([new Uint8Array(4 * 1024 * 1024)], { type: 'image/png' });
  const image = helper({ outputs: [small, small, small, new Blob(['fallback'], { type: 'image/jpeg' })] });
  assert.equal((await image.prepareWebPhoto(large)).type, 'image/jpeg', 'unsupported WebP encoding falls back without pretending a PNG meets byte target');
}
{
  const image = helper({ outputs: [] });
  await assert.rejects(image.prepareWebPhoto(new Blob(['oversized'], { type: 'image/heic' })), /Choose a smaller/);
  assert.deepEqual(image.revoked, ['blob:fixture']);
}
{
  const image = helper({ platform: 'ios' }), parts = [];
  await image.appendImageUpload({ append: (...args) => parts.push(args) }, { uri: 'file:///camera/photo.jpg', mimeType: 'image/jpeg', fileName: 'camera.jpg' });
  assert.equal(parts[0][1].uri, 'file:///camera/photo.jpg');
  assert.equal(parts[0][1].type, 'image/jpeg'); assert.equal(parts[0][1].name, 'camera.jpg');
  assert.equal(image.calls.length, 0, 'native streams picker URI instead of loading a blob');
}
{
  const image = helper({ input: small }), parts = [];
  await image.appendImageUpload({ append: (...args) => parts.push(args) }, { uri: 'blob:photo', mimeType: 'image/png', fileName: 'original.png' });
  assert.equal(parts[0][1], small); assert.equal(parts[0][2], 'original.png');
  await assert.rejects(image.appendImageUpload({ append: () => assert.fail('oversized image must not append') },
    { uri: 'blob:too-big', fileSize: 21 * 1024 * 1024 }), /smaller than 20 MB/);
}
console.log('Photo upload source preservation, hosted byte limit, alpha, portrait, HEIC decode/error, URL release and native URI streaming passed.');
{
  const image = helper(), parts = [];
  await image.appendImageUpload({ append: (...args) => parts.push(args) },
    { uri: 'blob:csp-blocked', file: small, mimeType: 'image/png', fileName: 'original.png' });
  assert.equal(parts[0][1], small);
  assert.equal(parts[0][2], 'original.png');
  assert.equal(image.calls.length, 0, 'web picker File uploads without fetching CSP-blocked blob URLs');
}
