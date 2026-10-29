import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const stableIdentity = () => {
  const controller = new AbortController();
  return { signal: controller.signal, isCurrent: () => !controller.signal.aborted, finish() {} };
};

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

// Downloads without an explicit floor inherit the selected workspace.
// Mobile fetch failures stay in the app; successful generation waits for a
// fresh tap before handing the blob to Safari's downloader or share sheet.
for (const document of [
  { path, filename: "Customer.pdf", expectedFilename: "Customer 29-10-2026 quotation PDF.pdf", disposition: "attachment; filename*=UTF-8\'\'Customer%2029-10-2026%20quotation%20PDF.pdf", label: "quotation PDF", type: "application/pdf", body: "%PDF-1.4" },
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
      : { beginIdentityOperation: stableIdentity, getToken: async () => null, getRequestFloorId: async () => "ground-floor", api: { base: "", authenticatedUrl: () => { throw new Error("Mobile downloads must not navigate to a one-use URL"); } } },
    document: { body: makeElement("body"), createElement: makeElement },
    URL: { createObjectURL: () => "blob:ready-pdf", revokeObjectURL() {} }, setTimeout() {},
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return fail ? { ok: false, status: 503, json: async () => ({ detail: "PDF generation failed" }) }
        : { ok: true, headers: { get: () => document.disposition || null }, blob: async () => new Blob([document.body], { type: document.type }) };
    },
  });
  const saving = module.exports.downloadApiFile(document.path, document.filename, document.label);
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
  assert.equal(anchor.download, document.expectedFilename || document.filename);
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

// Only authenticated quotation PDFs adopt the server name; malformed headers
// and non-PDF files preserve the explicit caller fallback.
for (const [path, disposition, expected] of [
  ["/quotations/q/portal-pdf/revision/2", 'attachment; filename="Client 29-10-2026 quotation PDF.pdf"', "Client 29-10-2026 quotation PDF.pdf"],
  ["/quotations/q/pdf", "attachment; filename*=UTF-8''%E0%A4%A8%E0%A4%BE%E0%A4%AE%2029-10-2026%20quotation%20PDF.pdf", "नाम 29-10-2026 quotation PDF.pdf"],
  ["/quotations/q/pdf", "attachment; filename*=UTF-8''%broken", "fallback.pdf"],
  ["/quotations/q/pdf", 'attachment; filename="../Client.pdf"', "..Client.pdf"],
  ["/quotations/q/pdf", 'attachment; filename="Client.xlsx"', "fallback.pdf"],
  ["/tile-orders/chalans/q/pdf", 'attachment; filename="Server.pdf"', "fallback.pdf"],
]) {
  const module = { exports: {} };
  const anchors = [];
  vm.runInNewContext(compile("../src/utils/downloadFile.ts"), {
    module, exports: module.exports, Blob, navigator: { userAgent: "Desktop Chrome" },
    require: name => name === "react-native" ? { Platform: { OS: "web" } } : name.includes("Toast")
      ? { toast: { show: value => { throw new Error(value); } } }
      : { beginIdentityOperation: stableIdentity, getToken: async () => null, getRequestFloorId: async () => "ground-floor", api: { base: "" } },
    document: { body: { appendChild: item => anchors.push(item) }, createElement: () => ({ click() {}, remove() {} }) },
    URL: { createObjectURL: () => "blob:named-pdf", revokeObjectURL() {} }, setTimeout() {},
    fetch: async () => ({ ok: true, headers: { get: () => disposition }, blob: async () => new Blob(["%PDF"], { type: "application/pdf" }) }),
  });
  assert.equal(await module.exports.downloadApiFile(path, "fallback.pdf"), true);
  assert.equal(anchors[0].download, expected);
}
console.log("Quotation response filenames: download/portal routes, Unicode, invalid encoding, path safety and unrelated documents passed");


// A slow token hydration must not move an in-flight download to another floor.
{
  const module = { exports: {} };
  const fetches = [];
  const previews = [];
  let selectedFloor = 'ground-floor';
  let releaseToken;
  const token = new Promise(resolve => { releaseToken = resolve; });
  const element = () => ({ style: {}, click() {}, remove() {} });
  vm.runInNewContext(compile('../src/utils/downloadFile.ts'), {
    module, exports: module.exports, navigator: { userAgent: 'Desktop Chrome' }, Blob,
    require: name => name === 'react-native' ? { Platform: { OS: 'web' } } : name.includes('Toast')
      ? { toast: { show: message => { throw new Error(message); } } }
      : { beginIdentityOperation: stableIdentity, getToken: () => token, getRequestFloorId: () => Promise.resolve(selectedFloor), api: { base: '' } },
    document: { body: { appendChild() {} }, createElement: element },
    window: { open: url => previews.push(url) },
    URL: { createObjectURL: () => 'blob:pdf', revokeObjectURL() {} }, setTimeout() {},
    fetch: async (url, options) => { fetches.push({ url, ...options }); return { ok: true, blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }) }; },
  });
  const pending = module.exports.downloadApiFile('/tile-orders/chalans/fixture/pdf', 'Chalan.pdf');
  selectedFloor = 'first-floor';
  releaseToken('fixture-token');
  assert.equal(await pending, true);
  assert.equal(fetches[0].headers['X-Floor-Id'], 'ground-floor', 'capture selected floor before awaiting token hydration');
  assert.equal(fetches[0].headers.Authorization, 'Bearer fixture-token');
  assert.equal(fetches[0].credentials, 'same-origin', 'cookie authentication is retained');
  await module.exports.downloadApiFile('/fixture.pdf', 'Fixture.pdf', 'PDF', 'second-floor');
  assert.equal(fetches[1].headers['X-Floor-Id'], 'second-floor', 'explicit source floor wins over ambient selection');
  await module.exports.openApiFile('/preview.pdf', 'PDF');
  assert.equal(fetches[2].headers['X-Floor-Id'], 'first-floor', 'preview uses the same floor-aware transport');
  assert.deepEqual(previews, ['blob:pdf']);
}
console.log('PDF download/preview: selected-floor fallback, explicit floor, delayed token race and cookie credentials passed');

// Desktop Kitchen Download uses the same prepared-file helper after chunk verification.
{
  const downloadModule = { exports: {} };
  const anchors = [];
  let clicked = 0;
  vm.runInNewContext(compile('../src/utils/downloadFile.ts'), {
    module: downloadModule, exports: downloadModule.exports, Blob,
    navigator: { userAgent: 'Chrome Desktop', platform: 'MacIntel', maxTouchPoints: 0 },
    document: { body: { appendChild: anchor => anchors.push(anchor) }, createElement: tag => ({ tag, click: () => clicked++, remove() {} }) },
    URL: { createObjectURL: blob => { assert.equal(blob.type, 'application/pdf'); return 'blob:verified-kitchen-pdf'; }, revokeObjectURL() {} },
    setTimeout() {},
    require: name => name === 'react-native' ? { Platform: { OS: 'web' } } : name.includes('Toast') ? { toast: { show() {} } } : { beginIdentityOperation: stableIdentity },
  });
  assert.equal(await downloadModule.exports.savePreparedFile(new Blob(['%PDF-verified'], { type: 'application/pdf' }), 'Final GI kitchen.pdf', 'project document'), true);
  assert.equal(clicked, 1);
  assert.equal(anchors[0].href, 'blob:verified-kitchen-pdf');
  assert.equal(anchors[0].download, 'Final GI kitchen.pdf');
  assert.equal(anchors[0].target, undefined);
  console.log('Desktop Kitchen PDF Download: original named PDF saves through a browser download anchor.');
}

// Run the binary lifecycle against both actual API-client implementations.
// Transport promises deliberately ignore abort so generation checks, rather
// than a cooperative fetch double, must prevent stale publication.
function realIdentityClient(path) {
  const loaded = { exports: {} };
  const storage = { getItem: async () => null, setItem: async () => true, removeItem: async () => true,
    secureGet: async () => null, secureSet: async () => true, secureRemove: async () => true };
  vm.runInNewContext(compile(path), {
    module: loaded, exports: loaded.exports, require: () => ({ storage, browserStorage: storage }),
    __DEV__: true, process: { env: { EXPO_PUBLIC_BACKEND_URL: 'https://dummy.invalid' } },
    document: { cookie: '' }, AbortController, DOMException, setTimeout, clearTimeout,
  });
  return loaded.exports;
}
function fileLifecycleHarness(identity, { mobile = false, transport } = {}) {
  const loaded = { exports: {} }, elements = [], clicks = [], opens = [], errors = [], revoked = [], timers = [], fetches = [];
  let prints = 0, shares = 0;
  const makeElement = tag => {
    const element = { tag, style: {}, children: [], removed: false, open: false,
      setAttribute() {}, append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
      insertBefore(item, before) { this.children.splice(this.children.indexOf(before), 0, item); },
      remove() { this.removed = true; }, close() { this.open = false; }, showModal() { this.open = true; }, focus() {},
      click() { clicks.push(this.download); }, contentWindow: { focus() {}, print() { prints++; } } };
    elements.push(element); return element;
  };
  vm.runInNewContext(compile('../src/utils/downloadFile.ts'), {
    module: loaded, exports: loaded.exports, Blob, File, AbortController, DOMException,
    navigator: { userAgent: mobile ? 'iPhone Safari' : 'Desktop Chrome', platform: mobile ? 'iPhone' : 'MacIntel', maxTouchPoints: mobile ? 5 : 0,
      canShare: () => true, share: async () => { shares++; } },
    document: { body: makeElement('body'), createElement: makeElement }, window: { open: url => opens.push(url) },
    URL: { createObjectURL: () => 'blob:private-dummy', revokeObjectURL: url => revoked.push(url) },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
    require: name => name === 'react-native' ? { Platform: { OS: 'web' } }
      : name.includes('Toast') ? { toast: { show: message => errors.push(message) } } : identity,
    fetch: (url, options) => {
      fetches.push({ url, options });
      return transport ? transport(url, options) : Promise.resolve({ ok: true, blob: async () => new Blob(['%PDF dummy private marker'], { type: 'application/pdf' }) });
    },
  });
  return { files: loaded.exports, elements, clicks, opens, errors, revoked, timers, fetches, prints: () => prints, shares: () => shares };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
for (const source of ['../src/api/client.ts', '../src/api/client.web.ts']) {
  for (const phase of ['credentials', 'response', 'body']) {
    const identity = realIdentityClient(source);
    await identity.setToken('dummy-A', 'staff'); identity.setRequestFloorId('first-floor');
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const normal = { ok: true, blob: async () => new Blob(['%PDF dummy A marker'], { type: 'application/pdf' }) };
    const apiDependency = phase === 'credentials' ? { ...identity, getToken: async () => { const value = await identity.getToken(); await held; return value; } } : identity;
    const harness = fileLifecycleHarness(apiDependency, { transport: async () => phase === 'response' ? held : phase === 'body' ? { ok: true, blob: () => held } : normal });
    const pending = harness.files.downloadApiFile('/portal/quotations/dummy-A/pdf', 'A-private.pdf');
    await nextTurn();
    await identity.clearToken(); await identity.setToken('dummy-B', 'customer'); await identity.setToken('dummy-A-new-session', 'staff');
    release(phase === 'response' ? normal : phase === 'body' ? await normal.blob() : undefined);
    assert.equal(await pending, false, `${source} ${phase}: A→B→A never revives old private bytes`);
    assert.deepEqual(harness.clicks, []); assert.deepEqual(harness.opens, []); assert.deepEqual(harness.errors, []);
    if (phase === 'credentials') assert.equal(harness.fetches.length, 0, 'identity changed during hydration: never start the old download');
    else assert.equal(harness.fetches[0].options.signal.aborted, true, 'identity transition aborts the actual binary transport');
  }
  {
    const identity = realIdentityClient(source); await identity.setToken('dummy-A', 'staff'); identity.setRequestFloorId('first-floor');
    let release; const body = new Promise(resolve => { release = resolve; });
    const harness = fileLifecycleHarness(identity, { transport: async () => ({ ok: true, blob: () => body }) });
    const pending = harness.files.downloadApiFile('/quotations/dummy/pdf', 'Permitted.pdf', 'PDF', 'ground-floor');
    await nextTurn(); identity.setRequestFloorId('second-floor');
    assert.equal(harness.fetches[0].options.signal.aborted, false, 'workspace navigation preserves explicit-source-floor downloads');
    release(new Blob(['%PDF permitted'], { type: 'application/pdf' }));
    assert.equal(await pending, true); assert.equal(harness.fetches[0].options.headers['X-Floor-Id'], 'ground-floor');
    assert.deepEqual(harness.clicks, ['Permitted.pdf']);
  }
  {
    const identity = realIdentityClient(source); await identity.setToken('dummy-A', 'staff');
    const harness = fileLifecycleHarness(identity, { mobile: true });
    const pending = harness.files.shareApiPdf('/quotations/dummy/pdf', 'A-private.pdf');
    await nextTurn();
    const dialog = harness.elements.find(element => element.tag === 'dialog');
    const download = harness.elements.find(element => element.textContent === 'Download');
    const share = harness.elements.find(element => element.textContent === 'Save or share');
    assert(dialog?.open); await identity.clearToken();
    assert.equal(await pending, false); assert.equal(dialog.removed, true, 'logout removes private filename and save controls');
    download.onclick(); share.onclick(); await nextTurn();
    assert.deepEqual(harness.clicks, []); assert.equal(harness.shares(), 0, 'retained stale gesture handlers cannot publish');
  }
  {
    const identity = realIdentityClient(source); await identity.setToken('dummy-A', 'staff');
    const harness = fileLifecycleHarness(identity);
    await harness.files.printApiFile('/quotations/dummy/pdf');
    const frame = harness.elements.find(element => element.tag === 'iframe'); const delayedLoad = frame.onload;
    assert.equal(typeof delayedLoad, 'function'); await identity.clearToken();
    assert.equal(frame.removed, true); assert.equal(frame.onload, null); delayedLoad();
    assert.equal(harness.prints(), 0); assert.deepEqual(harness.opens, []); assert.deepEqual(harness.revoked, ['blob:private-dummy']);
  }
}
console.log('Private binary identity lifecycle: real native/web clients reject held credentials/response/body after A→B→A, remove stale phone save controls/print frames, and preserve source-floor downloads.');
