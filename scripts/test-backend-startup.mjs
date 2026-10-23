import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const controllerSource = readFileSync(new URL('../src/lib/backend-startup-controller.ts', import.meta.url), 'utf8');
const controllerCode = ts.transpileModule(controllerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadController() {
  const exports = {};
  vm.runInNewContext(controllerCode, { exports, Date, setTimeout });
  return exports.createBackendStartup;
}

test('warm backend returns immediately without imposing a wake delay', async () => {
  let clock = 10_000;
  let probes = 0;
  const startup = loadController()({
    now: () => clock,
    probe: async () => { probes++; return true; },
    wait: async ms => { clock += ms; },
  });

  const started = clock;
  await startup.ensureReady();
  assert.equal(startup.getSnapshot().phase, 'ready');
  assert.equal(probes, 1);
  assert.equal(clock, started, 'a successful readiness probe must not sleep for the full window');
  await startup.ensureReady();
  assert.equal(probes, 1, 'the ready result is shared for its TTL');
});

test('overlapping callers share one pending wake attempt', async () => {
  let finishProbe;
  let probes = 0;
  const startup = loadController()({
    probe: () => { probes++; return new Promise(resolve => { finishProbe = resolve; }); },
  });

  const first = startup.ensureReady();
  const second = startup.ensureReady();
  assert.equal(first, second);
  assert.equal(probes, 1);
  finishProbe(true);
  await Promise.all([first, second]);
  assert.equal(startup.getSnapshot().phase, 'ready');
});

test('a backend that wakes around 50 seconds resolves on the first ready probe', async () => {
  let clock = 0;
  const probeTimes = [];
  const startup = loadController()({
    now: () => clock,
    probe: async timeoutMs => {
      probeTimes.push({ at: clock, timeoutMs });
      return clock >= 50_000;
    },
    wait: async ms => { clock += ms; },
  });

  await startup.ensureReady();
  assert.equal(startup.getSnapshot().phase, 'ready');
  assert.equal(probeTimes.at(-1).at, 50_000);
  assert.ok(probeTimes.length > 40 && probeTimes.length <= 51);
  assert.ok(probeTimes.every(probe => probe.timeoutMs > 0 && probe.timeoutMs <= 4_000));
  assert.equal(clock, 50_000, 'readiness must continue immediately instead of sleeping to the deadline');
});

test('probe attempts are at most four seconds and the whole wake loop ends by 60 seconds', async () => {
  let clock = 0;
  const timeouts = [];
  const startup = loadController()({
    now: () => clock,
    probe: async timeoutMs => {
      timeouts.push(timeoutMs);
      clock += timeoutMs; // A timed-out HTTP probe consumes no more than its supplied budget.
      return false;
    },
    wait: async ms => { clock += ms; },
  });

  await assert.rejects(startup.ensureReady(), /has not responded yet/);
  assert.equal(startup.getSnapshot().phase, 'unavailable');
  assert.ok(clock <= 60_000, `deadline exceeded: ${clock}ms`);
  assert.ok(timeouts.length > 0);
  assert.ok(timeouts.every(timeoutMs => timeoutMs > 0 && timeoutMs <= 4_000));
});

test('terminal failure does not restart automatically; an explicit retry can recover', async () => {
  let clock = 0;
  let probes = 0;
  let ready = false;
  const startup = loadController()({
    now: () => clock,
    probe: async timeoutMs => { probes++; clock += timeoutMs; return ready; },
    wait: async ms => { clock += ms; },
  });

  await assert.rejects(startup.ensureReady(), /has not responded yet/);
  assert.equal(startup.getSnapshot().phase, 'unavailable');
  const afterFailure = probes;
  await assert.rejects(startup.ensureReady(), /has not responded yet/);
  assert.equal(probes, afterFailure, 'a later automatic call must not launch another minute-long loop');

  ready = true;
  await startup.ensureReady({ retry: true });
  assert.equal(startup.getSnapshot().phase, 'ready');
  assert.equal(probes, afterFailure + 1);
});

test('web health probe is anonymous, uncached, abortable, and bounded to four seconds', async () => {
  const startupSource = readFileSync(new URL('../src/lib/backend-startup.web.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(startupSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const runtime = { time: 0, probeTimeouts: [], signals: [], requests: [] };
  const exports = {};
  const fakeSetTimeout = (callback, ms) => {
    if (ms <= 4_000) {
      runtime.probeTimeouts.push(ms);
      runtime.time += ms;
      callback();
    } else {
      runtime.time += ms;
      callback();
    }
    return 1;
  };
  const fakeClearTimeout = () => {};
  const fetch = (url, options) => {
    runtime.requests.push({ url, options });
    runtime.signals.push(options.signal);
    return new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
      else options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const controllerCompiled = ts.transpileModule(startupSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const controllerExports = {};
  vm.runInNewContext(controllerCode, { exports: controllerExports, Date: { now: () => runtime.time }, setTimeout: fakeSetTimeout });
  vm.runInNewContext(controllerCompiled, {
    exports, AbortController, DOMException, fetch, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    __DEV__: false, process: { env: { EXPO_PUBLIC_BACKEND_URL: 'https://dev-api.example.test/' } },
    require: name => {
      assert.equal(name, './backend-startup-controller');
      return controllerExports;
    },
  });

  await assert.rejects(exports.ensureBackendReady(), /has not responded yet/);
  assert.ok(runtime.requests.length > 0);
  assert.ok(runtime.probeTimeouts.every(timeoutMs => timeoutMs > 0 && timeoutMs <= 4_000));
  assert.ok(runtime.time <= 60_000, `probe loop exceeded its deadline: ${runtime.time}ms`);
  assert.ok(runtime.requests.every(({ url, options }) => {
    return url === '/api/health/ready' && options.credentials === 'omit' && options.cache === 'no-store';
  }));
  assert.ok(runtime.signals.every(signal => signal.aborted), 'each timed-out request must be aborted');

  const developmentExports = {};
  const developmentRequests = [];
  vm.runInNewContext(controllerCompiled, {
    exports: developmentExports, AbortController, DOMException,
    fetch: async (url, options) => {
      developmentRequests.push({ url, options });
      return { ok: true, json: async () => ({ status: 'ok' }) };
    },
    setTimeout, clearTimeout, __DEV__: true,
    process: { env: { EXPO_PUBLIC_BACKEND_URL: 'https://dev-api.example.test///' } },
    require: name => {
      assert.equal(name, './backend-startup-controller');
      return controllerExports;
    },
  });
  await developmentExports.ensureBackendReady();
  assert.equal(developmentRequests.length, 1);
  assert.equal(developmentRequests[0].url, 'https://dev-api.example.test/api/health/ready', 'development uses configured HTTPS and removes trailing slashes');
  assert.equal(developmentRequests[0].options.credentials, 'omit');
  assert.equal(developmentRequests[0].options.cache, 'no-store');
});

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
