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

// Mobile fetch failures stay in the app; successful generation waits for a
// fresh tap before handing the blob to Safari's downloader or share sheet.
for (const document of [
  { path, filename: "Customer.pdf", label: "quotation PDF", type: "application/pdf", body: "%PDF-1.4" },
  { path: "/quotations/q-tablet/pptx", filename: "Customer PPT 05-10-2026.pptx", label: "product PPT",
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", body: "PK" },
]) {
for (const navigator of [
  { userAgent: "iPhone Safari", platform: "iPhone", maxTouchPoints: 5 },
  { userAgent: "Android Chrome", platform: "Linux", maxTouchPoints: 5, dialogUnsupported: true, fileUnsupported: true },
  { userAgent: "iPhone embedded", canShare() { throw new Error("Unsupported"); }, share: async () => {} },
  { userAgent: "iPhone Safari", canShare: () => true, share: async () => { throw Object.assign(new Error("Cancelled"), { name: "AbortError" }); } },
  { userAgent: "iPhone Safari", canShare: () => true, share: async () => {}, shareSucceeds: true },
  { userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 5 },
]) {
  const module = { exports: {} };
  const elements = [];
  const errors = [];
  const fetches = [];
  let fail = false;
  let clicks = 0;
  let focused = null;
  const makeElement = tag => {
    const element = { tag, style: {}, children: [], setAttribute() {}, append(...items) { this.children.push(...items); },
      appendChild(item) { this.children.push(item); }, insertBefore(item, before) { this.children.splice(this.children.indexOf(before), 0, item); },
      remove() {}, close() {}, showModal() {}, focus() { focused = this; }, click() { clicks++; } };
    if (navigator.dialogUnsupported) element.showModal = undefined;
    elements.push(element);
    return element;
  };
  vm.runInNewContext(compile("../src/utils/downloadFile.ts"), {
    module, exports: module.exports, navigator, File: navigator.fileUnsupported ? undefined : File, Blob,
    require: name => name === "react-native" ? { Platform: { OS: "web" } } : name.includes("Toast")
      ? { toast: { show: value => errors.push(value) } }
      : { getToken: async () => null, api: { base: "", authenticatedUrl: () => { throw new Error("Mobile downloads must not navigate to a one-use URL"); } } },
    document: { body: makeElement("body"), createElement: makeElement },
    URL: { createObjectURL: () => "blob:ready-pdf", revokeObjectURL() {} }, setTimeout() {},
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return fail ? { ok: false, status: 503, json: async () => ({ detail: "PDF generation failed" }) }
        : { ok: true, blob: async () => new Blob([document.body], { type: document.type }) };
    },
  });
  const saving = module.exports.downloadApiFile(document.path, document.filename, document.label, "ground-floor");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clicks, 0, "the async fetch must not trigger a download without a fresh tap");
  assert.equal(fetches[0].options.headers["X-Floor-Id"], "ground-floor");
  assert.equal(fetches[0].url, `/api${document.path}`);
  assert.equal(fetches[0].options.credentials, "same-origin");
  const saveOrShare = elements.find(element => element.textContent === "Save or share");
  assert.match(elements.find(element => element.tag === "p")?.textContent, /Save to Files/);
  if (saveOrShare) {
    const actionContainer = elements.find(element => element.children.includes(saveOrShare));
    assert.equal(actionContainer.children[0], saveOrShare, "put Save or share before the browser-download fallback");
  }
  if (saveOrShare) assert.equal(focused, saveOrShare, "prefer the destination picker on phones that support file sharing");
  if (saveOrShare && !navigator.shareSucceeds) {
    saveOrShare.onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, [], "share cancellation keeps Download available without an error");
  }
  if (saveOrShare && navigator.shareSucceeds) {
    saveOrShare.onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await saving, true, "the native save/share picker should complete the primary action");
    assert.equal(clicks, 0, "the primary save/share action should not launch a new browser tab");
    continue;
  }
  elements.find(element => element.textContent === "Download").onclick();
  assert.equal(await saving, true);
  assert.equal(clicks, 1);
  const anchor = elements.find(element => element.tag === "a");
  assert.equal(anchor.href, "blob:ready-pdf");
  assert.equal(anchor.download, document.filename);
  assert.equal(anchor.target, undefined, "download should not force the file into a separate tab");
  const cancelled = module.exports.downloadApiFile(document.path, document.filename, document.label, "ground-floor");
  await new Promise(resolve => setImmediate(resolve));
  elements.filter(element => element.textContent === "Cancel").at(-1).onclick();
  assert.equal(await cancelled, false);
  fail = true;
  assert.equal(await module.exports.downloadApiFile(document.path, document.filename, document.label, "ground-floor"), false);
  assert.deepEqual(errors, ["PDF generation failed"]);
  assert.equal(clicks, 1);
}
}
console.log("PDF/PPT downloads: floor binding, mobile fresh-gesture save, and recoverable generation failures passed");
