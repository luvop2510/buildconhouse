import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { performance } from 'node:perf_hooks';

// Exercise the actual native and browser modules with a controlled clock and
// catalog-sized synthetic pages. Instrumented maps expose retained payloads,
// not GC-dependent heap readings; no real credentials/API are used.
const evidence = [];
for (const path of ['../src/api/client.ts', '../src/api/client.web.ts']) {
  let now = 1000;
  let requests = 0;
  const maps = [];
  class ObservedMap extends Map { constructor(...args) { super(...args); maps.push(this); } }
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} };
  const storage = { secureGet: async () => null, getItem: async () => 'first-floor',
    secureSet: async () => {}, setItem: async () => {}, secureRemove: async () => {}, removeItem: async () => {} };
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `product-${i}`, name: 'Synthetic basin', description: 'x'.repeat(1024) }));
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
    __DEV__: true, process: { env: {} }, document: { cookie: '' },
    Map: ObservedMap, Date: Clock, AbortController, DOMException, setTimeout, clearTimeout,
    fetch: async () => { requests++; return { ok: true, text: async () => JSON.stringify({ total: 6000, items }) }; },
  });
  const client = module.exports;
  client.setRequestFloorId('first-floor');
  const { api } = client;
  const started = performance.now();
  for (let i = 0; i < 1000; i++) await api.get(`/products?q=query-${i}&limit=60`, { cacheMs: 60_000 });
  const cache = maps.find(map => [...map.values()].some(value => value?.expiresAt));
  const retainedEntries = cache.size;
  const retainedPayloadBytes = [...cache.values()].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value.value)), 0);
  const populationMs = performance.now() - started;
  now += 60_001;
  await api.get('/brands', { cacheMs: 300_000 });
  const entriesAfterExpiry = cache.size;
  const measurement = { client: path, pages: 1000, pageSize: 60, retainedEntries, retainedPayloadBytes, entriesAfterExpiry, populationMs };
  evidence.push(measurement);
  console.log(JSON.stringify(measurement));
  if (process.env.CACHE_RETENTION_BASELINE) continue;
  assert.ok(retainedEntries <= 64, `${path}: long-session cache must have bounded retention`);
  assert.equal(entriesAfterExpiry, 1, `${path}: expired pages must be released on another cache insertion`);

  client.clearApiResponseCache();
  for (let i = 0; i < 64; i++) await api.get(`/products?page=${i}`, { cacheMs: 60_000 });
  const beforeHit = requests;
  await api.get('/products?page=0', { cacheMs: 60_000 });
  assert.equal(requests, beforeHit, 'recent page is served from cache');
  await api.get('/products?page=64', { cacheMs: 60_000 });
  await api.get('/products?page=0', { cacheMs: 60_000 });
  assert.equal(requests, beforeHit + 1, 'a touched page survives least-recently-used eviction');
  await api.get('/products?page=1', { cacheMs: 60_000 });
  assert.equal(requests, beforeHit + 2, 'evicted pages remain accessible by refetching');
  client.setRequestFloorId('ground-floor');
  assert.equal(cache.size, 0, 'workspace changes release cached data');
  await api.get('/brands', { cacheMs: 300_000 });
  await client.clearToken();
  assert.equal(cache.size, 0, 'identity changes release cached data');
}
if (process.env.CACHE_RETENTION_REPORT) writeFileSync(process.env.CACHE_RETENTION_REPORT, JSON.stringify(evidence, null, 2) + '\n');
console.log('Actual-client long-session retention, TTL cleanup, LRU, refetch and isolation checks passed.');
