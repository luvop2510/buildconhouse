import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

for (const name of ['use-floor-access.ts', 'use-floor-access.web.ts']) {
  test(`${name} starts the real access read directly and rejects stale cache publication`, async () => {
    const source = readFileSync(new URL(`../src/hooks/${name}`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const requests = [];
    const exports = {};
    const modules = {
      react: {}, 'expo-router': {}, '@/src/components/Toast': {},
      '@/src/utils/storage': {}, '@/src/utils/storage/browser.web': {},
      '@/src/api/client': {
        setRequestFloorId() {},
        api: { get(path, options) {
          const call = { path, options };
          call.promise = new Promise(resolve => { call.resolve = resolve; });
          requests.push(call);
          return call.promise;
        } },
      },
    };
    vm.runInNewContext(compiled, { exports, Promise, Error, require: dependency => {
      assert.ok(dependency in modules, `Unexpected floor dependency ${dependency}; access must not wait for anonymous health`);
      return modules[dependency];
    } });
    const first = exports.getFloorAccess();
    assert.equal(requests.length, 1, 'the authoritative request starts synchronously without a health prerequisite');
    assert.equal(requests[0].path, '/settings/floor-access');
    assert.equal(requests[0].options.floorId, '', 'account access must omit stale business floor');
    const second = exports.getFloorAccess();
    assert.equal(requests.length, 1, 'overlapping callers share the actual access request');
    exports.resetFloorAccess();
    const current = exports.getFloorAccess();
    assert.equal(requests.length, 2);
    const newAccess = { floors: [{ id: 'new-floor' }], floor_ids: ['new-floor'] };
    requests[1].resolve(newAccess);
    assert.equal(await current, newAccess);
    requests[0].resolve({ floors: [{ id: 'old-floor' }], floor_ids: ['old-floor'] });
    await Promise.all([first, second]);
    assert.equal(await exports.getFloorAccess(), newAccess, 'a previous identity cannot restore its floor cache');
    assert.equal(requests.length, 2);
  });
}

test('Vercel proxy and standalone worker bound readiness to 3.5s while normal API calls retain 28s', async () => {
  process.env.BACKEND_URL = 'https://api.example.test';
  const [{ createHandler }, { createWorker }] = await Promise.all([
    import('../api/[...path].js'),
    import('./web-worker.mjs'),
  ]);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  function nodeRequest(path) {
    const req = new EventEmitter();
    req.method = 'GET';
    req.query = { path: path.split('/') };
    req.url = `/api/${path}`;
    req.headers = { host: 'buildcon.example' };
    req.resume = () => {};
    queueMicrotask(() => req.emit('end'));
    return req;
  }
  const nodeResponse = () => ({
    headers: {}, statusCode: 200, payload: undefined,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    send(value) { this.payload = value; return this; },
  });

  async function withTimers({ abortAt, collect }, work) {
    globalThis.setTimeout = (callback, ms, ...args) => {
      collect.push(ms);
      if (ms === abortAt) callback(...args);
      return 123;
    };
    globalThis.clearTimeout = () => {};
    try { return await work(); }
    finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
  }
  const abortingFetch = async (_url, options) => {
    assert.equal(options.signal.aborted, true, 'the short health deadline aborts the upstream request');
    throw Object.assign(new Error('aborted by the readiness deadline'), { name: 'AbortError' });
  };
  const immediateFetch = async () => Response.json({ status: 'ok' });

  const vercelReadinessTimers = [];
  const vercelReadiness = nodeResponse();
  await withTimers({ abortAt: 3_500, collect: vercelReadinessTimers }, () => createHandler({
    backendUrl: 'https://api.example.test', timeoutMs: 28_000, fetchImpl: abortingFetch,
  })(nodeRequest('health/ready'), vercelReadiness));
  assert.deepEqual(vercelReadinessTimers, [3_500]);
  assert.equal(vercelReadiness.statusCode, 504);

  const vercelNormalTimers = [];
  const vercelNormal = nodeResponse();
  await withTimers({ abortAt: -1, collect: vercelNormalTimers }, () => createHandler({
    backendUrl: 'https://api.example.test', timeoutMs: 28_000, fetchImpl: immediateFetch,
  })(nodeRequest('customers'), vercelNormal));
  assert.deepEqual(vercelNormalTimers, [28_000]);
  assert.equal(vercelNormal.statusCode, 200);

  const worker = createWorker('https://api.example.test', abortingFetch);
  const workerReadinessTimers = [];
  const workerReadiness = await withTimers({ abortAt: 3_500, collect: workerReadinessTimers }, () => worker.fetch(
    new Request('https://buildcon.example/api/health/ready'), {},
  ));
  assert.deepEqual(workerReadinessTimers, [3_500]);
  assert.equal(workerReadiness.status, 504);

  const normalWorker = createWorker('https://api.example.test', immediateFetch);
  const workerNormalTimers = [];
  const workerNormal = await withTimers({ abortAt: -1, collect: workerNormalTimers }, () => normalWorker.fetch(
    new Request('https://buildcon.example/api/customers'), {},
  ));
  assert.deepEqual(workerNormalTimers, [28_000]);
  assert.equal(workerNormal.status, 200);
});
