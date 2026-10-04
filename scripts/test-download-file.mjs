import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Exercise the real web API client: a token for a quotation from another
// workspace must inherit the explicitly requested floor, including query flags.
const client = { exports: {} };
const requests = [];
vm.runInNewContext(compile("../src/api/client.web.ts"), {
  module: client, exports: client.exports,
  require: () => ({ browserStorage: { getItem: async () => "first-floor" } }),
  __DEV__: false, process: { env: {} }, document: { cookie: "forge_csrf=csrf-value" },
  AbortController, DOMException, setTimeout, clearTimeout,
  fetch: async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, text: async () => '{"token":"one-use-token"}' };
  },
});
client.exports.setRequestFloorId("first-floor");
const path = "/quotations/q-tablet/pdf?include_dimensions=true";
assert.equal(await client.exports.api.authenticatedUrl(path, "ground-floor"), `/api${path}&dl=one-use-token`);
assert.equal(requests[0].headers["X-Floor-Id"], "ground-floor");
assert.equal(requests[0].headers["X-CSRF-Token"], "csrf-value");
assert.equal(JSON.parse(requests[0].body).target, `/api${path}`);

// iPadOS presents a desktop Mac UA; touch capability must still select the
// authenticated attachment path, avoiding a delayed blob/popup download.
for (const navigator of [
  { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 },
  { userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0) Safari/605.1.15", platform: "iPad", maxTouchPoints: 5 },
]) {
  const module = { exports: {} };
  const navigations = [];
  const calls = [];
  const errors = [];
  let fail = false;
  vm.runInNewContext(compile("../src/utils/downloadFile.ts"), {
    module, exports: module.exports, navigator,
    require: (name) => name === "react-native" ? { Platform: { OS: "web" } } : name.includes("Toast")
      ? { toast: { show: value => errors.push(value) } }
      : { api: { authenticatedUrl: async (...args) => { calls.push(args); if (fail) throw new Error("offline"); return "/api/attachment?dl=one-use-token"; } } },
    window: { location: { assign: value => navigations.push(value) } },
    fetch: () => { throw new Error("iPad must not fetch a blob before navigating"); },
  });
  assert.equal(await module.exports.downloadApiFile(path, "Customer.pdf", "quotation PDF", "ground-floor"), true);
  assert.deepEqual([...calls[0]], [path, "ground-floor"]);
  assert.deepEqual(navigations, ["/api/attachment?dl=one-use-token"]);
  fail = true;
  assert.equal(await module.exports.downloadApiFile(path, "Customer.pdf", "quotation PDF", "ground-floor"), false);
  assert.equal(navigations.length, 1);
  assert.deepEqual(errors, ["Couldn't download the quotation PDF"]);
}
console.log("Quotation downloads: explicit token floor binding and iPadOS attachment/retry paths passed");
