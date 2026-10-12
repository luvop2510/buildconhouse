import './test-api-cache-retention.mjs';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

for (const path of ["../src/api/client.ts", "../src/api/client.web.ts"]) {
  const source = read(path);
  // A GET transport is shared, but each component retains ownership of its
  // own cancellation.  One unmounted consumer must not abort the others.
  assert.match(source, /function abortForConsumer/);
  assert.match(source, /request<T>\("GET", \w+, undefined, \{ \.\.\.opts, signal: undefined \}\)/);
  assert.match(source, /return abortForConsumer\(existing as Promise<T>, opts\?\.signal\)/);
  assert.match(source, /return abortForConsumer\(pending, opts\?\.signal\)/);

  // Failures must evict the transport, and stale workspace results still
  // reject rather than updating consumers from the previous context.
  assert.match(source, /inflightGets\.get\(key\) === pending/);
  assert.match(source, /contextVersion !== requestContextVersion/);
  assert.match(source, /Request timed out\. Please try again\./);
  assert.match(source, /Cannot reach the backend/);
}

// Run both real clients with controlled transports: an old response must not
// be reused after a write, populate the cache, or evict the newer shared read.
for (const path of ["../src/api/client.ts", "../src/api/client.web.ts"]) {
  for (const method of ["post", "put", "patch", "delete"]) {
    for (const oldFinishesFirst of [true, false]) {
      const reads = [];
      const module = { exports: {} };
      const storage = { secureGet: async () => null, getItem: async () => "first-floor" };
      const code = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      vm.runInNewContext(code, {
        module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
        __DEV__: true, process: { env: {} }, document: { cookie: "" },
        AbortController, DOMException, setTimeout, clearTimeout,
        fetch: (_url, options) => options.method === "GET"
          ? new Promise(resolve => reads.push(value => resolve({ ok: true, text: async () => JSON.stringify({ value }) })))
          : Promise.resolve({ ok: true, text: async () => '{"saved":true}' }),
      });
      const { api } = module.exports;
      module.exports.setRequestFloorId("first-floor");
      const old = api.get("/payments/orders", { cacheMs: 10_000 });
      await new Promise(resolve => setImmediate(resolve));
      const sharedOld = api.get("/payments/orders");
      assert.equal(reads.length, 1);
      await api[method]("/payments", method === "delete" ? undefined : { amount: 10 });
      const fresh = api.get("/payments/orders", { cacheMs: 10_000 });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads.length, 2, `${path} ${method}: fresh transport after mutation`);
      if (oldFinishesFirst) {
        reads[0]("old");
        await old;
        const sharedFresh = api.get("/payments/orders");
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(reads.length, 2, "old finally cannot evict the new transport");
        reads[1]("fresh");
        assert.equal((await sharedFresh).value, "fresh");
      } else {
        reads[1]("fresh");
        await fresh;
        reads[0]("old");
      }
      assert.equal((await old).value, "old");
      assert.equal((await sharedOld).value, "old");
      assert.equal((await fresh).value, "fresh");
      assert.equal((await api.get("/payments/orders")).value, "fresh", "old response cannot poison the new cache");
      assert.equal(reads.length, 2);
    }
  }
}

console.log("API client cancellation/context contracts and 16 mutation/read race scenarios passed");

// Slow device storage must never resurrect a previous identity or workspace.
for (const path of ["../src/api/client.ts", "../src/api/client.web.ts"]) {
  function controlledClient() {
    const pendingStorage = new Map();
    const requests = [];
    const storage = {
      secureGet: key => new Promise(resolve => pendingStorage.set(key, resolve)),
      getItem: key => new Promise(resolve => pendingStorage.set(key, resolve)),
      secureSet: async () => true, setItem: async () => true,
      secureRemove: async () => true, removeItem: async () => true,
    };
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(read(path), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
      __DEV__: true, process: { env: { EXPO_PUBLIC_BACKEND_URL: "https://api.example.test" } },
      document: { cookie: "" }, AbortController, DOMException, setTimeout, clearTimeout,
      fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, text: async () => '{"ok":true}' }; },
    });
    return { client: module.exports, pendingStorage, requests };
  }
  for (const action of ["login", "logout"]) {
    const { client, pendingStorage } = controlledClient();
    const tokenRead = client.getToken();
    const kindRead = client.getTokenKind();
    if (action === "login") await client.setToken("new-customer-token", "customer");
    else await client.clearToken();
    if (path.endsWith("client.ts")) pendingStorage.get("forge.jwt")("old-staff-token");
    else assert.equal(pendingStorage.has("forge.jwt"), false, "browser credentials must never hydrate from persistent storage");
    pendingStorage.get("forge.jwt.kind")("staff");
    assert.equal(await tokenRead, path.endsWith("client.ts") && action === "login" ? "new-customer-token" : null, `${path}: stale token read after ${action}`);
    assert.equal(await kindRead, action === "login" ? "customer" : null);
    assert.equal(await client.getToken(), action === "login" ? "new-customer-token" : null);
  }
  {
    const { client, pendingStorage, requests } = controlledClient();
    await client.setToken("staff-token", "staff");
    const pending = client.api.get("/products", { cacheMs: 10000 });
    await new Promise(resolve => setImmediate(resolve));
    client.setRequestFloorId("ground-floor");
    pendingStorage.get("forge.active-floor")("first-floor");
    await pending;
    assert.equal(requests[0].headers["X-Floor-Id"], "ground-floor", `${path}: stale floor read cannot override selection`);
    await client.api.get("/brands");
    assert.equal(requests[1].headers["X-Floor-Id"], "ground-floor");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.api.get("/brands", { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(client.api.get("/products", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(requests.length, 2, "cancelled reads must not create transports or return cached data");
  }
}
console.log("API slow-storage identity/floor and cancelled-read regressions passed");

// Identity hydration belongs to the signed-in account, not the selected floor.
// A deep link may change floors while /auth/me or personal grants are loading.
for (const path of ['../src/api/client.ts', '../src/api/client.web.ts']) {
  for (const identityPath of ['/auth/me', '/auth/customer/me', '/settings/access-grants/me']) {
    const transports = [];
    const module = { exports: {} };
    const storage = { secureGet: async () => null, getItem: async () => 'first-floor', secureSet: async () => {}, setItem: async () => {}, secureRemove: async () => {}, removeItem: async () => {} };
    vm.runInNewContext(ts.transpileModule(read(path), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
      __DEV__: true, process: { env: {} }, document: { cookie: '' },
      AbortController, DOMException, setTimeout, clearTimeout,
      fetch: (url, options) => new Promise(resolve => transports.push({ url, options,
        finish: () => resolve({ ok: true, text: async () => '{"id":"fixture-identity"}' }) })),
    });
    const client = module.exports;
    client.setRequestFloorId('first-floor');
    const identity = client.api.get(identityPath);
    const identityResult = identity.then(value => ({ value }), error => ({ error }));
    const floorRead = client.api.get('/quotations/fixture-floor');
    const floorResult = floorRead.then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(transports.length, 2);
    client.setRequestFloorId('ground-floor');
    assert.equal(transports[0].options.signal.aborted, false, `${path} ${identityPath}: changing floors must not abort account hydration`);
    assert.equal(transports[1].options.signal.aborted, true, `${path}: old-floor business read must still abort`);
    transports.forEach(transport => transport.finish());
    assert.equal((await identityResult).value.id, 'fixture-identity');
    assert.equal((await floorResult).error.name, 'AbortError');
    for (const transition of ['login', 'logout']) {
      const pending = client.api.get(identityPath).then(value => ({ value }), error => ({ error }));
      await new Promise(resolve => setImmediate(resolve));
      const transport = transports.at(-1);
      if (transition === 'login') await client.setToken('fixture-new-identity', 'customer');
      else await client.clearToken();
      assert.equal(transport.options.signal.aborted, true, `${path} ${identityPath}: ${transition} must abort old identity hydration`);
      transport.finish();
      assert.equal((await pending).error.name, 'AbortError');
    }
  }
}
console.log('Identity hydration survives workspace changes; login/logout still reject old identity and workspace transports.');

// Explicit refreshes bypass completed cached reads on native and web.
for (const path of ['../src/api/client.ts', '../src/api/client.web.ts']) {
  let reads = 0;
  const module = { exports: {} };
  const storage = { secureGet: async () => null, getItem: async () => 'first-floor' };
  vm.runInNewContext(ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
    __DEV__: true, process: { env: {} }, document: { cookie: '' },
    AbortController, DOMException, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ value: ++reads }) }),
  });
  module.exports.setRequestFloorId('first-floor');
  const { api } = module.exports;
  assert.equal((await api.get('/dashboard/stats', { cacheMs: 15000 })).value, 1);
  assert.equal((await api.get('/dashboard/stats')).value, 1);
  assert.equal(reads, 1);
  assert.equal((await api.get('/dashboard/stats', { cacheMs: 0 })).value, 2);
  assert.equal(reads, 2);
}
console.log('Native/web explicit refresh bypasses completed response cache.');

// Cookie parsing must match the proxy's raw-value comparison and must never
// crash all mutations when a stale browser cookie contains malformed escapes.
{
  const requests = [];
  const document = { cookie: 'other=one;forge_csrf=%ZZ' };
  const module = { exports: {} };
  const storage = { secureGet: async () => null, getItem: async () => 'first-floor' };
  vm.runInNewContext(ts.transpileModule(read('../src/api/client.web.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, require: () => ({ browserStorage: storage }),
    __DEV__: false, process: { env: {} }, document, AbortController, DOMException, setTimeout, clearTimeout,
    fetch: async (_url, options) => { requests.push(options); return { ok: true, text: async () => '{"ok":true}' }; },
  });
  for (const value of ['%ZZ', 'encoded%2Fcsrf%3D', 'value=with=equals']) {
    document.cookie = `other=one;forge_csrf=${value}; last=two`;
    assert.equal(module.exports.csrfHeaders()['X-CSRF-Token'], value);
    await module.exports.api.post('/auth/login', { email: 'fixture', password: 'fixture' });
    assert.equal(requests.at(-1).headers['X-CSRF-Token'], value);
  }
  document.cookie = 'other=one; forge_csrf=';
  assert.equal(Object.keys(module.exports.csrfHeaders()).length, 0);
}
console.log('Browser CSRF cookie parsing preserves raw values and malformed cookies cannot crash credential login.');

// A genuinely stalled transport must time out, release the shared GET and
// allow recovery without disturbing another usable request. Drive the real
// 30-second callback directly, avoiding a slow or flaky wall-clock test.
for (const path of ['../src/api/client.ts', '../src/api/client.web.ts']) {
  const timers = [];
  const requests = [];
  let fail = true;
  const module = { exports: {} };
  const storage = { secureGet: async () => null, getItem: async () => 'first-floor' };
  vm.runInNewContext(ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
    __DEV__: true, process: { env: {} }, document: { cookie: '' },
    AbortController, DOMException,
    setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimeout: () => {},
    fetch: (url, options) => {
      requests.push(url);
      if (fail && url.includes('/products')) return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('fixture timeout', 'AbortError')), { once: true });
      });
      return Promise.resolve({ ok: true, text: async () => '{"recovered":true}' });
    },
  });
  module.exports.setRequestFloorId('first-floor');
  const stalled = module.exports.api.get('/products');
  const result = stalled.then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await module.exports.api.get('/brands')).recovered, true);
  assert.equal(timers[0].ms, 30000);
  timers[0].callback();
  assert.equal((await result).error.status, 408);
  fail = false;
  assert.equal((await module.exports.api.get('/products')).recovered, true);
  assert.equal(requests.filter(url => url.includes('/products')).length, 2);
}
console.log('Native/web stalled transports time out, evict shared reads, and recover while unrelated reads remain usable.');
