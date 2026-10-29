import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real transport against the installed native API contract. This
// proves control flow and byte identity; it is not a signed physical-device run.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = Buffer.alloc(1_100_000, 17); source.write('%PDF-1.4');
const files = new Map([['file:///selected.pdf', Buffer.from(source)]]);
const shares = [];
const errors = [];
let sharingAvailable = true;
let nativeReadWork;
let sharingAvailabilityWork;
const preparedBlobs = [];
const blobTimers = [];
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
const stableIdentity = () => {
  const controller = new AbortController();
  return { signal: controller.signal, isCurrent: () => !controller.signal.aborted, finish() {} };
};
const modules = {
  'react-native': { Platform: { OS: 'ios' }, Linking: {} },
  'expo-file-system': { File: NativeFile, Paths: { cache: 'file:///cache' } },
  'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digest: (algorithm, bytes) => webcrypto.subtle.digest(algorithm, bytes) },
  'expo-sharing': { isAvailableAsync: async () => sharingAvailabilityWork ? sharingAvailabilityWork() : sharingAvailable, shareAsync: async (uri, options) => { assert(files.has(uri)); shares.push({ uri, options, bytes: Buffer.from(files.get(uri)) }); } },
  '@/src/components/Toast': { toast: { show: value => errors.push(value) } },
  '@/src/api/client': { beginIdentityOperation: stableIdentity, api: { base: 'https://native.invalid' }, getToken: async () => 'synthetic-token', getRequestFloorId: async () => 'second-floor' },
};
function load(path, { cryptoImpl = webcrypto } = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, Uint8Array, ArrayBuffer, Date, Math, AbortController, DOMException,
    // RN Blob cannot construct from byte arrays and has no arrayBuffer method.
    Blob: modules['react-native'].Platform.OS === 'web' ? Blob : class { constructor() { throw new Error('Unsupported native Blob byte construction'); } },
    crypto: cryptoImpl, URL: { createObjectURL: blob => { preparedBlobs.push(blob); return 'blob:verified'; }, revokeObjectURL: () => {} }, setTimeout: (callback, delay) => blobTimers.push([callback, delay]),
    FileReader: class { readAsDataURL(blob) { const finish = () => { this.result = `data:${blob.type};base64,${blob.bytes.toString('base64')}`; this.onload(); }; if (nativeReadWork) nativeReadWork(finish); else finish(); } },
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
let transferState = 'open';
let finishCalls = 0;
const uploads = [];
modules['@/src/api/kitchenProjects'] = { kitchenProjectsApi: {
  beginTransfer: async (_project, value) => { assert.equal(value.sha256, sha(selected)); uploads.push({ ...value, parts: [] }); return { transfer_id: `transfer-${uploads.length}`, size_bytes: selected.length, chunk_bytes: 524288, part_count: Math.ceil(selected.length / 524288), state: transferState }; },
  uploadPart: async (_project, _transfer, index, base64) => { uploads.at(-1).parts[index] = Buffer.from(base64, 'base64'); },
  finishTransfer: async () => { finishCalls++; if (transferState === 'open') assert.deepEqual(Buffer.concat(uploads.at(-1).parts), selected); return { id: 'project', version: 2 }; },
  downloadPart: async (_project, _attachment, index) => {
    const bytes = source.subarray(index * 524288, (index + 1) * 524288);
    return { index, size_bytes: source.length, data_base64: bytes.toString('base64'), sha256: corruptPart ? '0'.repeat(64) : sha(bytes), file_sha256: corruptFull ? '1'.repeat(64) : sha(source) };
  },
} };
const transport = load('../src/components/kitchen/KitchenFileTransport.ts');
const asset = { uri: 'file:///selected.pdf', name: 'Drawing.pdf', mimeType: 'application/pdf', size: source.length };
for (const OS of ['ios', 'android']) {
  modules['react-native'].Platform.OS = OS;
  const progress = [];
  await transport.uploadKitchenFile({ id: 'project', version: 1 }, asset, `new-file-${OS}`, value => progress.push(value), () => {});
  assert.equal(progress.at(-1), 100);
  const attachment = { id: 'attachment', filename: 'Drawing.pdf', content_type: 'application/pdf', size_bytes: source.length, sha256: sha(source) };
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

modules['react-native'].Platform.OS = 'web';
const webTransport = load('../src/components/kitchen/KitchenFileTransport.ts');
const webAttachment = {id:'attachment',filename:'Drawing.pdf',content_type:'application/pdf',size_bytes:source.length,sha256:sha(source)};
const preview = {closed:false,location:{href:'about:blank'}};
assert.equal(await webTransport.downloadKitchenFile('project',webAttachment,()=>{},preview),true);
assert.equal(preview.location.href,'blob:verified');
assert.equal(sha(new Uint8Array(await preparedBlobs.at(-1).arrayBuffer())),sha(source),'The preview receives only fully verified original PDF bytes');
assert.equal(blobTimers.at(-1)[1],120_000,'The browser can finish loading before the blob URL is revoked');
corruptPart=true;
preview.location.href='about:blank';
await assert.rejects(webTransport.downloadKitchenFile('project',webAttachment,()=>{},preview),/part failed integrity/);
assert.equal(preview.location.href,'about:blank','Corrupt PDF bytes never navigate the preview');
corruptPart=false;
preview.closed=true;
await assert.rejects(webTransport.downloadKitchenFile('project',webAttachment,()=>{},preview),/preview was closed/);
console.log('Web Kitchen PDF preview: full-byte SHA-256 verification, private chunk transport, corrupt-byte refusal and closed-window recovery passed.');

assert.equal(transport.KITCHEN_MAX_PDF_BYTES,10_000_000);
await assert.rejects(transport.uploadKitchenFile({id:'project',version:1},{...asset,size:10_000_001},'too-big',()=>{},()=>{}),/10 MB/);
await assert.rejects(transport.uploadKitchenFile({id:'project',version:1},{...asset,name:'renamed.bin',mimeType:'application/pdf',size:10_000_001},'renamed-big',()=>{},()=>{}),/10 MB/);
assert.equal(transport.KITCHEN_MAX_FILE_BYTES,25_000_000,'Historical file downloads retain the original 25 MB support');
console.log('Kitchen PDF upload cap: 10 MB by PDF filename or MIME; existing historical download limit retained.');

modules['react-native'].Platform.OS = 'ios';
for (const state of ['finishing', 'completed']) {
  transferState = state;
  const previousFinishes = finishCalls;
  const progress = [];
  await transport.uploadKitchenFile({ id: 'project', version: 2 }, asset, `retry-${state}`, value => progress.push(value), () => {});
  assert.equal(uploads.at(-1).parts.length, 0, `An explicit retry of a ${state} transfer never resends immutable parts`);
  assert.equal(finishCalls, previousFinishes + 1, 'The exact finalization endpoint resolves its existing attachment receipt');
  assert.equal(progress.at(-1), 100);
}
console.log('Kitchen upload recovery: finishing/completed receipts reach finalization without resending parts.');

// Use the actual native client identity generation, rather than a token-value
// comparison: returning to account A is still a new session.
const identityModule = { exports: {} };
const identityStorage = { getItem: async () => null, setItem: async () => true, removeItem: async () => true,
  secureGet: async () => null, secureSet: async () => true, secureRemove: async () => true };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/api/client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  module: identityModule, exports: identityModule.exports, require: () => ({ storage: identityStorage }),
  __DEV__: true, process: { env: { EXPO_PUBLIC_BACKEND_URL: 'https://dummy.invalid' } },
  AbortController, DOMException, setTimeout, clearTimeout,
});
const identity = identityModule.exports;
modules['@/src/api/client'] = identity;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
for (const phase of ['native-reader', 'share-availability']) {
  modules['react-native'].Platform.OS = 'ios';
  await identity.setToken('dummy-A', 'staff'); identity.setRequestFloorId('second-floor');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  if (phase === 'native-reader') nativeReadWork = finish => { void held.then(finish); };
  else sharingAvailabilityWork = () => held;
  const guardedSaving = load('../src/utils/downloadFile.ts');
  const beforeShares = shares.length;
  const pending = guardedSaving.downloadApiFile('/dummy-A.pdf', 'Private A.pdf', 'PDF', 'second-floor');
  await nextTurn();
  if (phase === 'share-availability') assert.equal(files.size, 2, 'native private cache exists only while its source identity is active');
  await identity.clearToken(); await identity.setToken('dummy-B', 'customer'); await identity.setToken('dummy-A-new-session', 'staff');
  assert.equal(files.size, 1, 'identity transition removes any already-created private cache file before delayed work returns');
  release(true); assert.equal(await pending, false);
  assert.equal(shares.length, beforeShares, 'old private bytes never reach the native share sink');
  assert.equal(files.size, 1, 'delayed preparation leaves no private cache file');
  nativeReadWork = undefined; sharingAvailabilityWork = undefined;
}
console.log('Native private-file publication: held FileReader/share availability cannot outlive A→B→A; private cache files are removed on logout.');

// Kitchen verifies all chunks and then awaits a separate full-file SHA-256.
// Identity changes in that final gap must not navigate the reserved preview.
modules['react-native'].Platform.OS = 'web';
await identity.setToken('dummy-A', 'staff'); identity.setRequestFloorId('second-floor');
let releaseFinalHash, finalHashReached;
const waitingForFinalHash = new Promise(resolve => { finalHashReached = resolve; });
const heldFinalHash = new Promise(resolve => { releaseFinalHash = resolve; });
let digestCalls = 0;
const guardedTransport = load('../src/components/kitchen/KitchenFileTransport.ts', { cryptoImpl: { subtle: {
  digest: async (algorithm, bytes) => {
    digestCalls++;
    const result = await webcrypto.subtle.digest(algorithm, bytes);
    if (digestCalls === Math.ceil(source.length / 524288) + 1) { finalHashReached(); await heldFinalHash; }
    return result;
  },
} } });
const privatePreview = { closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } };
const beforePrepared = preparedBlobs.length;
const waitingDownload = guardedTransport.downloadKitchenFile('project', webAttachment, () => {}, privatePreview);
await waitingForFinalHash;
await identity.clearToken(); await identity.setToken('dummy-B', 'customer'); await identity.setToken('dummy-A-new-session', 'staff');
assert.equal(privatePreview.closed, true, 'logout closes the pending private preview immediately');
releaseFinalHash(); assert.equal(await waitingDownload, false);
assert.equal(privatePreview.location.href, 'about:blank');
assert.equal(preparedBlobs.length, beforePrepared, 'a stale verified PDF never receives a browser blob URL');
console.log('Kitchen private PDF: identity change during final SHA-256 closes the pending preview and prevents byte publication.');
