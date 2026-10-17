import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = await readFile(new URL('./release-recovery.js', import.meta.url), 'utf8');
const base = 'https://app.example.test';
const asset = `${base}/_expo/static/js/web/entry-a1.js`;
class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.innerHTML = ''; this.textContent = ''; this.interactive = false; }
  focus() { this.focused = true; }
  get childElementCount() { return this.children.length; }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  querySelector() { return this.interactive ? {} : null; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}
function harness({ storage = new Map(), storageFails = false, initial = '', interactive = false, entry = asset, readyState = 'complete', pathname = '/quotations/q1' } = {}) {
  const root = new Element('div'); root.id = 'root'; root.innerHTML = initial; root.interactive = interactive;
  if (initial) root.appendChild(new Element('div'));
  const body = new Element('body'); body.appendChild(root);
  const window = new EventTarget(); const document = new EventTarget();
  const timers = []; let reloads = 0; let observerCallback;
  Object.assign(document, { readyState, body,
    getElementById(id) { return [root, ...body.children].find(element => element.id === id) || null; },
    createElement(tag) { return new Element(tag); },
    querySelectorAll() { return entry ? [{ src: entry }] : []; },
  });
  const location = { origin: base, href: `${base}${pathname}`, pathname, reload() { reloads++; } };
  vm.runInNewContext(source, { window, document, location, URL, setTimeout(callback, delay = 0) { timers.push({ callback, delay }); },
    sessionStorage: { getItem(key) { if (storageFails) throw Error('blocked'); return storage.get(key); }, setItem(key, value) { if (storageFails) throw Error('blocked'); storage.set(key, value); }, removeItem(key) { if (storageFails) throw Error('blocked'); storage.delete(key); } },
    MutationObserver: class { constructor(callback) { observerCallback = callback; } observe() {} disconnect() {} },
  });
  function event(values, type = 'error') {
    const actual = new Event(type);
    for (const [key, value] of Object.entries(values)) Object.defineProperty(actual, key, { value });
    window.dispatchEvent(actual);
  }
  return { root, body, document, storage, initialRoute: window.__FORGE_INITIAL_ROUTE__, isReleaseError: window.__FORGE_IS_RELEASE_ERROR__, get reloads() { return reloads; }, panel() { return body.children.find(element => element.id === 'release-startup-recovery'); }, flush(maxDelay = 0) { let index; while ((index = timers.findIndex(timer => timer.delay <= maxDelay)) >= 0) timers.splice(index, 1)[0].callback(); }, event,
    script(url = asset) { event({ target: { tagName: 'SCRIPT', src: url } }); }, mutate() { root.innerHTML = '<div>Live app</div>'; root.children = [new Element('div')]; observerCallback?.(); },
  };
}
const stalled = harness({ readyState: 'loading', initial: '<div>Loading</div>' });
stalled.flush(); assert.equal(stalled.panel(), undefined);
stalled.flush(20000); assert.ok(stalled.panel(), 'Stalled startup must provide a visible manual recovery action');
assert.equal(stalled.reloads, 0); stalled.mutate(); assert.equal(stalled.panel(), undefined);
const liveWatchdog = harness(); liveWatchdog.mutate(); liveWatchdog.flush(20000);
assert.equal(liveWatchdog.panel(), undefined); assert.equal(liveWatchdog.reloads, 0);
const routeStorage = new Map();
assert.equal(harness({ storage: routeStorage, pathname: '/quotations/new?productId=basin' }).initialRoute, '/quotations/new?productId=basin');
assert.equal(harness({ storage: routeStorage, pathname: '/access' }).initialRoute, '/quotations/new?productId=basin');
harness({ storage: routeStorage, pathname: '/login' });
assert.equal(routeStorage.has('forge.pending-initial-route'), false);
assert.equal(harness({ storage: new Map([['forge.pending-initial-route', '//untrusted.test']]), pathname: '/access' }).initialRoute, '/access');

const detector = harness();
assert.equal(detector.isReleaseError({ message: 'Loading chunk 27 failed', stack: `Error\n at load (${asset}:1:2)` }), true);
assert.equal(detector.isReleaseError({ message: 'Requiring unknown module "669".', stack: `Error\n at p (${base}/_expo/static/js/web/__expo-metro-runtime-hash.js:2:3)` }), true);
assert.equal(detector.isReleaseError({ message: 'TypeError: name is undefined', stack: `Error\n at render (${asset}:1:2)` }), false);
assert.equal(detector.isReleaseError({ message: 'Loading chunk 27 failed', stack: 'Error\n at load (https://third.example.test/script.js:1:2)' }), false);
assert.equal(detector.isReleaseError(null), false);
assert.equal(detector.isReleaseError({ name: 'AsyncRequireError', message: `Loading module ${base}/_expo/static/js/web/QuotationBuilder-old.js failed.\n(error: ${base}/_expo/static/js/web/QuotationBuilder-old.js)`, request: `${base}/_expo/static/js/web/QuotationBuilder-old.js` }), true);
assert.equal(detector.isReleaseError({ name: 'AsyncRequireError', message: 'Loading module https://third.example.test/module.js failed.', request: 'https://third.example.test/module.js' }), false);
detector.mutate(); detector.isReleaseError({ message: 'Loading chunk 27 failed', stack: `Error\n at load (${asset}:1:2)` }); detector.flush();
assert.equal(detector.reloads, 0, 'Classification must not reload mounted UI or discard form state');
const first = harness(); first.script(); first.script(); first.flush(); assert.equal(first.reloads, 1);
const retry = harness({ storage: first.storage }); retry.script(); retry.flush(); assert.equal(retry.reloads, 0);
assert.equal(retry.panel().attributes.role, 'alert'); assert.match(retry.panel().style.cssText, /position:fixed;inset:0/); assert.equal(retry.panel().children[2].focused, true); assert.equal(retry.panel().children[2].textContent, 'Reload app');
retry.script(); retry.flush(); assert.equal(retry.body.children.length, 2);
retry.panel().children[2].dispatchEvent(new Event('click')); assert.equal(retry.reloads, 1);
const changedEntry = harness({ storage: first.storage, entry: `${base}/_expo/static/js/web/entry-a2.js` }); changedEntry.script(); changedEntry.flush(); assert.equal(changedEntry.reloads, 1);
const blocked = harness({ storageFails: true }); blocked.script(); blocked.flush(); assert.equal(blocked.reloads, 0); assert.ok(blocked.panel()); blocked.mutate(); assert.equal(blocked.panel(), undefined);
const mounted = harness(); mounted.mutate(); mounted.script(); mounted.flush(); assert.equal(mounted.reloads, 0); assert.equal(mounted.panel(), undefined);
const shell = harness({ initial: '<div class="splash">Loading</div>' }); shell.script(); shell.flush(); assert.equal(shell.reloads, 1);
const ssrUI = harness({ initial: '<div><button>Save</button></div>', interactive: true }); ssrUI.script(); ssrUI.flush(); assert.equal(ssrUI.reloads, 0); assert.equal(ssrUI.panel(), undefined);
const altered = harness({ initial: '<div>Loading</div>' }); altered.root.innerHTML = '<div>New screen</div>'; altered.script(); altered.flush(); assert.equal(altered.reloads, 0);
const renderedBeforeRetry = harness(); renderedBeforeRetry.script(); renderedBeforeRetry.mutate(); renderedBeforeRetry.flush(); assert.equal(renderedBeforeRetry.reloads, 0);
const ignored = harness(); ignored.script('https://third.example.test/_expo/static/js/web/entry-a1.js'); ignored.event({ target: { tagName: 'IMG', src: asset } }); ignored.event({ message: 'API request failed: 503', filename: asset }); ignored.event({ message: 'Unexpected token <', filename: `${base}/api/orders` }); ignored.event({ message: 'Unexpected token <', filename: 'https://third.example.test/_expo/static/js/web/bad.js' }); ignored.flush(); assert.equal(ignored.reloads, 0);
const parse = harness(); parse.event({ message: "Unexpected token '<'", filename: asset }); parse.flush(); assert.equal(parse.reloads, 1);
const metro = harness(); metro.event({ message: 'Requiring unknown module "669".', error: { stack: `Error: Requiring unknown module "669".\n at p (${base}/_expo/static/js/web/__expo-metro-runtime-hash.js:2:2249)` } }); metro.flush(); assert.equal(metro.reloads, 1);
const chunk = harness(); chunk.event({ message: 'Loading chunk 27 failed', filename: asset }); chunk.flush(); assert.equal(chunk.reloads, 1);
const asyncChunk = harness(); asyncChunk.event({ reason: { message: 'Loading chunk 27 failed', stack: `Error: Loading chunk 27 failed\n at load (${asset}:1:2)` } }, 'unhandledrejection'); asyncChunk.flush(); assert.equal(asyncChunk.reloads, 1);
const asyncApi = harness(); asyncApi.event({ reason: { message: "Unexpected token '<'", stack: `SyntaxError\n at JSON.parse (${asset}:1:2)` } }, 'unhandledrejection'); asyncApi.event({ reason: { message: 'API request failed: 503', stack: `Error\n at request (${asset}:1:2)` } }, 'unhandledrejection'); asyncApi.flush(); assert.equal(asyncApi.reloads, 0);
const asyncThirdParty = harness(); asyncThirdParty.event({ reason: { message: 'Loading chunk 27 failed', stack: 'Error\n at load (https://third.example.test/_expo/static/js/web/entry-a1.js:1:2)' } }, 'unhandledrejection'); asyncThirdParty.flush(); assert.equal(asyncThirdParty.reloads, 0);
const dom = harness({ readyState: 'loading' }); dom.script(); dom.flush(); assert.equal(dom.reloads, 0); dom.document.readyState = 'interactive'; dom.document.dispatchEvent(new Event('DOMContentLoaded')); dom.flush(); assert.equal(dom.reloads, 1);
const noFingerprint = harness({ entry: null }); noFingerprint.script(); noFingerprint.flush(); assert.equal(noFingerprint.reloads, 0); assert.ok(noFingerprint.panel());

// Execute the actual builder injection block against nested temporary HTML,
// without invoking Expo or touching release build output.
const builder = await readFile(new URL('./sites-build.mjs', import.meta.url), 'utf8');
const injection = builder.slice(builder.indexOf('  const recoverySource ='), builder.indexOf("  await mkdir('dist',"));
assert.ok(injection.includes("await injectRecovery('dist/client')"));
const directory = await mkdtemp(join(tmpdir(), 'forge-recovery-'));
const cwd = process.cwd();
try {
  await mkdir(join(directory, 'dist/client/quotations'), { recursive: true });
  const html = '<html><head><script type="module">/* preloads */</script></head><body><div id="root"><div>Loading</div></div><script src="/_expo/static/js/web/entry-a1.js" defer></script></body></html>';
  await writeFile(join(directory, 'dist/client/index.html'), html);
  await writeFile(join(directory, 'dist/client/quotations/detail.html'), html);
  process.chdir(directory);
  const script = `(async () => { ${injection.replace("new URL('./release-recovery.js', import.meta.url)", JSON.stringify(fileURLToPath(new URL('./release-recovery.js', import.meta.url))))} })()`;
  await vm.runInNewContext(script, { readFile, readdir, writeFile });
  await vm.runInNewContext(script, { readFile, readdir, writeFile });
  for (const path of ['index.html', 'quotations/detail.html']) {
    const injected = await readFile(join(directory, 'dist/client', path), 'utf8');
    assert.equal((injected.match(/src="\/release-recovery.js"/g) || []).length, 1);
    assert.ok(injected.indexOf('id="root"') < injected.indexOf('src="/release-recovery.js"'));
    assert.ok(injected.includes('<script src="/release-recovery.js"></script><script src="/_expo/static/js/web/entry-a1.js" defer>'));
    assert.doesNotMatch(injected, /src="\/release-recovery.js"[^>]*(?:async|defer)/);
  }
  assert.equal(await readFile(join(directory, 'dist/client/release-recovery.js'), 'utf8'), source);
} finally { process.chdir(cwd); await rm(directory, { recursive: true, force: true }); }
console.log('Startup recovery: resource/parse/chunk errors, one retry, SSR/root guards, API/cross-origin isolation, storage failure, manual fallback and real builder placement passed.');
