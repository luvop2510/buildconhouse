import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const nativeOrigin = JSON.parse(read('../eas.json')).build.production.env.EXPO_PUBLIC_BACKEND_URL;
const webOrigin = /BACKEND_URL:\s*(https:\/\/\S+)/.exec(read('../.github/workflows/ci.yml'))?.[1];
assert.equal(nativeOrigin, webOrigin, 'Signed native and CI web releases must target the same backend');
assert.equal(new URL(nativeOrigin).protocol, 'https:');
assert.equal(new URL(nativeOrigin).origin, nativeOrigin, 'Native production backend must be a bare HTTPS origin');

// Exercise the actual native production client with a hermetic transport.
const requests = [];
const module = { exports: {} };
const storage = { secureGet: async () => null, getItem: async () => 'first-floor' };
vm.runInNewContext(ts.transpileModule(read('../src/api/client.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  module, exports: module.exports, require: () => ({ storage }),
  __DEV__: false, process: { env: { EXPO_PUBLIC_BACKEND_URL: nativeOrigin } },
  AbortController, DOMException, setTimeout, clearTimeout,
  fetch: async (url, options) => {
    requests.push({ url, method: options.method });
    return { ok: true, text: async () => '{"status":"ok"}' };
  },
});
assert.equal((await module.exports.api.get('/health')).status, 'ok');
assert.deepEqual(requests, [{ url: `${nativeOrigin}/api/health`, method: 'GET' }]);
console.log('Native release backend alignment and production-client routing passed (hermetic transport)');
