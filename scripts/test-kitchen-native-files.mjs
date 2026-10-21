import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real transport against the installed native API contract. This
// proves control flow and byte identity; it is not a signed physical-device run.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = Buffer.alloc(1_100_000, 17); source.write('AC1015');
const files = new Map([['file:///selected.dwg', Buffer.from(source)]]);
const shares = [];
const errors = [];
let sharingAvailable = true;
class NativeFile {
  constructor(...paths) { this.uri = paths.join('/'); }
  get exists() { return files.has(this.uri); }
  create() { assert.equal(this.exists, false); files.set(this.uri, Buffer.alloc(0)); }
  delete() { assert(this.exists); files.delete(this.uri); }
  bytes() { return Promise.resolve(new Uint8Array(files.get(this.uri))); }
  write(value, options) { files.set(this.uri, typeof value === 'string' ? Buffer.from(value, options.encoding) : Buffer.from(value)); }
  open() {
    assert(this.exists);
    const file = this;
    return { offset: 0, closed: false,
      readBytes(length) { assert(!this.closed); const bytes = files.get(file.uri).subarray(this.offset, this.offset + length); this.offset += bytes.length; return new Uint8Array(bytes); },
      writeBytes(bytes) { assert(!this.closed); files.set(file.uri, Buffer.concat([files.get(file.uri), bytes])); this.offset += bytes.length; },
      close() { assert(!this.closed); this.closed = true; },
    };
  }
}
const modules = {
  'react-native': { Platform: { OS: 'ios' }, Linking: {} },
  'expo-file-system': { File: NativeFile, Paths: { cache: 'file:///cache' } },
  'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digest: (algorithm, bytes) => webcrypto.subtle.digest(algorithm, bytes) },
  'expo-sharing': { isAvailableAsync: async () => sharingAvailable, shareAsync: async (uri, options) => { assert(files.has(uri)); shares.push({ uri, options, bytes: Buffer.from(files.get(uri)) }); } },
  '@/src/components/Toast': { toast: { show: value => errors.push(value) } },
  '@/src/api/client': { api: { base: 'https://native.invalid' }, getToken: async () => 'synthetic-token' },
};
function load(path) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, Uint8Array, ArrayBuffer, Date, Math,
    // RN Blob cannot construct from byte arrays and has no arrayBuffer method.
    Blob: class { constructor() { throw new Error('Unsupported native Blob byte construction'); } },
    FileReader: class { readAsDataURL(blob) { this.result = `data:${blob.type};base64,${blob.bytes.toString('base64')}`; this.onload(); } },
    btoa: value => Buffer.from(value, 'binary').toString('base64'), atob: value => Buffer.from(value, 'base64').toString('binary'),
    require: name => { assert(name in modules, `Unexpected dependency: ${name}`); return modules[name]; },
    fetch: async (_url, options) => { assert.equal(options.headers['X-Floor-Id'], 'second-floor'); return { ok: true, blob: async () => ({ type: 'application/pdf', bytes: Buffer.from('%PDF native bytes') }) }; },
  });
  return module.exports;
}
const saving = load('../src/utils/downloadFile.ts');
modules['@/src/utils/downloadFile'] = saving;
assert.equal(await saving.downloadApiFile('/synthetic.pdf', 'Customer.pdf', 'PDF', 'second-floor'), true);
assert.equal(shares[0].bytes.toString(), '%PDF native bytes');
assert.equal(shares[0].options.mimeType, 'application/pdf');
assert.equal(files.size, 1, 'small native download removes its private cache copy after sharing');

let selected = source;
let corruptPart = false;
let corruptFull = false;
const uploads = [];
modules['@/src/api/kitchenProjects'] = { kitchenProjectsApi: {
  beginTransfer: async (_project, value) => { assert.equal(value.sha256, sha(selected)); uploads.push({ ...value, parts: [] }); return { transfer_id: `transfer-${uploads.length}`, size_bytes: selected.length, chunk_bytes: 524288, part_count: Math.ceil(selected.length / 524288), state: 'open' }; },
  uploadPart: async (_project, _transfer, index, base64) => { uploads.at(-1).parts[index] = Buffer.from(base64, 'base64'); },
  finishTransfer: async () => { assert.deepEqual(Buffer.concat(uploads.at(-1).parts), selected); return { id: 'project', version: 2 }; },
  downloadPart: async (_project, _attachment, index) => {
    const bytes = source.subarray(index * 524288, (index + 1) * 524288);
    return { index, size_bytes: source.length, data_base64: bytes.toString('base64'), sha256: corruptPart ? '0'.repeat(64) : sha(bytes), file_sha256: corruptFull ? '1'.repeat(64) : sha(source) };
  },
} };
const transport = load('../src/components/kitchen/KitchenFileTransport.ts');
const asset = { uri: 'file:///selected.dwg', name: 'Drawing.dwg', mimeType: 'application/acad', size: source.length };
for (const OS of ['ios', 'android']) {
  modules['react-native'].Platform.OS = OS;
  const progress = [];
  await transport.uploadKitchenFile({ id: 'project', version: 1 }, asset, `new-file-${OS}`, value => progress.push(value), () => {});
  assert.equal(progress.at(-1), 100);
  const attachment = { id: 'attachment', filename: 'Drawing.dwg', content_type: 'application/acad', size_bytes: source.length, sha256: sha(source) };
  assert.equal(await transport.downloadKitchenFile('project', attachment, () => {}), true);
  assert.deepEqual(shares.at(-1).bytes, source);
  assert.equal(files.size, 1, 'large native download closes and deletes the verified temporary file');
  const priorShares = shares.length;
  corruptPart = true;
  await assert.rejects(transport.downloadKitchenFile('project', attachment, () => {}), /part failed integrity/);
  corruptPart = false;
  corruptFull = true;
  await assert.rejects(transport.downloadKitchenFile('project', { ...attachment, sha256: undefined }, () => {}), /failed integrity/);
  corruptFull = false;
  assert.equal(shares.length, priorShares, 'corrupt bytes never reach the share sheet');
  assert.equal(files.size, 1, 'failed verification removes partial native output');
  sharingAvailable = false;
  assert.equal(await transport.downloadKitchenFile('project', attachment, () => {}), false);
  sharingAvailable = true;
  assert.equal(files.size, 1);
}
selected = Buffer.from(source); selected[10] = 99; files.set(asset.uri, selected);
await transport.uploadKitchenFile({ id: 'project', version: 2 }, asset, 'new-revision-same-name-size', () => {}, () => {});
assert.notEqual(uploads.at(-1).sha256, uploads[0].sha256, 'same filename and size preserve distinct native content identity');
assert.deepEqual(errors, ['Sharing is unavailable on this device', 'Sharing is unavailable on this device']);
console.log('Native Kitchen files: iOS/Android contract, SHA-256 upload identity, bounded file writes, full/part corruption rejection, share and cleanup passed (no physical-device claim).');
