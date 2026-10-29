import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let pass = 0; pass < 30; pass++) await Promise.resolve(); };
function fixture(path, fault) {
  const waiting = deferred(), timers = new Map(), requests = [], signals = [];
  let timerId = 0;
  class Controller extends AbortController {
    constructor() {
      super();
      const signal = this.signal, listeners = new Set();
      const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); return add(type, listener, options); };
      signal.removeEventListener = (type, listener, options) => { if (type === 'abort') listeners.delete(listener); return remove(type, listener, options); };
      signals.push(listeners);
    }
  }
  const storage = {
    secureGet: () => fault === 'credentials' ? waiting.promise : Promise.resolve(null),
    getItem: () => fault === 'floor' ? waiting.promise : Promise.resolve('second-floor'),
  };
  const module = { exports: {} };
  const source = readFileSync(new URL(`../src/api/${path}`, import.meta.url), 'utf8')
    + '\nexport function deadlineDiagnostics() { return activeRequests.size; }';
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
    __DEV__: true, process: { env: {} }, document: { cookie: '' }, AbortController: Controller, DOMException,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => {
      requests.push({ url, ...options });
      if (fault === 'transport') return waiting.promise;
      return Promise.resolve({ ok: true, text: () => fault === 'body' ? waiting.promise : Promise.resolve('{"saved":true}') });
    },
  });
  const caller = new Controller();
  return { client: module.exports, waiting, requests, caller, timers, signals,
    start() {
      return module.exports.api.post('/kitchen-projects/project/commands', { command: 'move_stage', payload: { target_stage: 'order' } }, {
        ...(fault !== 'floor' ? { floorId: 'second-floor' } : {}), signal: caller.signal,
      });
    },
    deadline() {
      const entry = [...timers.entries()].find(([, timer]) => timer.ms === 30_000);
      assert.ok(entry, 'original 30 second deadline starts before any storage or transport await');
      timers.delete(entry[0]); entry[1].fn();
    },
    clean() {
      assert.equal(timers.size, 0, 'finished requests release their deadline');
      assert.equal(module.exports.deadlineDiagnostics(), 0, 'finished requests leave no active controller');
      assert.ok(signals.every(listeners => listeners.size === 0), 'caller and operation abort listeners are removed');
    },
  };
}

for (const path of ['client.ts', 'client.web.ts']) {
  for (const fault of ['floor', 'transport', 'body', ...(path === 'client.ts' ? ['credentials'] : [])]) {
    const f = fixture(path, fault);
    const request = f.start();
    const rejection = assert.rejects(request, error => error.status === 408);
    await flush(); f.deadline(); await rejection;
    assert.equal(f.requests.length, ['credentials', 'floor'].includes(fault) ? 0 : 1);
    f.clean();
    // Neither a late storage result nor an ignored transport abort may send a
    // delayed write or publish success after the UI has offered a safe retry.
    f.waiting.resolve(fault === 'transport' ? { ok: true, text: async () => '{"late":true}' } : 'late');
    await flush();
    assert.equal(f.requests.length, ['credentials', 'floor'].includes(fault) ? 0 : 1);
    f.clean();
  }
  for (const cancellation of ['caller', 'context']) {
    const f = fixture(path, path === 'client.ts' ? 'credentials' : 'floor');
    const request = f.start();
    const rejection = assert.rejects(request, error => error.name === 'AbortError');
    await flush();
    if (cancellation === 'caller') f.caller.abort();
    else f.client.invalidateApiRequests();
    await rejection; f.clean();
    // The rejected late storage promise remains observed after cancellation.
    f.waiting.reject(new Error('Late device storage failure'));
    await flush();
    assert.equal(f.requests.length, 0); f.clean();
  }
  const failedStorage = fixture(path, path === 'client.ts' ? 'credentials' : 'floor');
  const rejected = assert.rejects(failedStorage.start(), /Device storage failed/);
  await flush(); failedStorage.waiting.reject(new Error('Device storage failed'));
  await rejected; failedStorage.clean();
  const success = fixture(path, 'none');
  assert.equal((await success.start()).saved, true); success.clean();
}
console.log('API native/web deadline: hung credentials, floor, transport and body settle; cancellation/rejection clean up; late results cannot send writes.');
