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
