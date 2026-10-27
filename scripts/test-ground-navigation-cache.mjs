import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
for (const name of ['client.ts', 'client.web.ts']) {
  let count = 0, now = 1000;
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  const storage = { secureGet: async () => null, getItem: async () => 'ground-floor', secureSet: async () => {}, setItem: async () => {}, secureRemove: async () => {}, removeItem: async () => {} };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/api/${name}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, require: () => ({ storage, browserStorage: storage }), Date: Clock,
    __DEV__: true, process: { env: {} }, document: { cookie: '' }, AbortController, DOMException, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ version: ++count }) }),
  });
  const client = module.exports, { api } = client;
  client.setRequestFloorId('ground-floor');
  const first = await api.get('/payments/orders');
  assert.equal((await api.get('/payments/orders')).version, first.version);
  now += 2001;
  assert.notEqual((await api.get('/payments/orders')).version, first.version, 'navigation cache expires');
  const beforeWrite = count;
  await api.patch('/payments/orders/q/manual-extra', { amount: 5 });
  await api.get('/payments/orders');
  assert.equal(count, beforeWrite + 2, 'committed writes evict list data');
  const beforeFresh = count;
  await api.get('/payments/orders', { cacheMs: 0 });
  await api.get('/payments/orders/q'); await api.get('/payments/orders/q');
  assert.equal(count, beforeFresh + 3, 'explicit refresh and editable detail always reach API');
  const beforeSwitch = count;
  client.setRequestFloorId('first-floor'); await api.get('/payments/orders'); await api.get('/payments/orders');
  assert.equal(count, beforeSwitch + 2, 'cache never crosses floors');
  client.setRequestFloorId('ground-floor'); await api.get('/payments/orders');
  const beforeLogout = count;
  await client.clearToken(); await api.get('/payments/orders');
  assert.equal(count, beforeLogout + 1, 'logout evicts private data');
}
console.log('Ground Floor navigation caching: expiry, writes, explicit refresh, fresh detail and identity/floor isolation passed.');
