import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/hooks/use-keyboard-viewport.ts', import.meta.url), 'utf8');
for (const file of ['../app/_layout.tsx', '../app/_layout.web.tsx']) {
  assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /useKeyboardViewport\(\)/, `${file} mounts keyboard geometry`);
}
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const viewport = new EventTarget();
Object.assign(viewport, { height: 1024, offsetTop: 0, scale: 1 });
const win = new EventTarget();
win.visualViewport = viewport;
win.getComputedStyle = element => ({ overflowY: element.overflowY || 'visible' });
const doc = new EventTarget();
const properties = new Map();
let writes = 0, scrolls = 0, cleanup;
doc.documentElement = { style: {
  setProperty: (key, value) => { writes++; properties.set(key, value); },
  removeProperty: key => properties.delete(key),
} };
class Input {
  matches() { return true; }
  getBoundingClientRect() { return this.box; }
  scrollIntoView(options) { assert.equal(options.block, 'nearest'); scrolls++; }
  box = { top: 40, bottom: 90 };
}
doc.activeElement = new Input();
const callbacks = new Map();
let nextFrame = 0;
const frames = () => { for (const [id, callback] of [...callbacks]) { callbacks.delete(id); callback(); } };
const exports = {};
vm.runInNewContext(compiled, {
  exports, window: win, document: doc, HTMLElement: Input,
  requestAnimationFrame: callback => { const id = ++nextFrame; callbacks.set(id, callback); return id; },
  cancelAnimationFrame: id => callbacks.delete(id),
  require: name => name === 'react' ? { useEffect: effect => { cleanup = effect(); } } : { Platform: { OS: 'web' } },
});
exports.useKeyboardViewport();
frames(); frames();
assert.equal(properties.get('--forge-visible-height'), '1024px');
assert.equal(scrolls, 0, 'Already visible input does not scroll');
Object.assign(viewport, { height: 300, offsetTop: 20 });
doc.activeElement.box = { top: 700, bottom: 750 };
const beforeBurst = writes;
for (let i = 0; i < 30; i++) {
  viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'));
}
assert.equal(callbacks.size, 1, 'Resize/scroll bursts share a single frame');
frames(); frames();
assert.equal(writes - beforeBurst, 2, 'Burst writes viewport geometry once');
assert.equal(properties.get('--forge-visible-top'), '20px');
assert.equal(scrolls, 1, 'Keyboard-clipped focus is brought into view after layout');
const afterResize = writes;
for (let i = 0; i < 3; i++) {
  viewport.dispatchEvent(new Event('scroll')); frames(); frames();
}
assert.equal(scrolls, 1, 'Focus scrolling must not trigger another automatic scroll');
assert.equal(writes, afterResize, 'Unchanged viewport events do not rewrite app geometry');
viewport.offsetTop = 25;
viewport.dispatchEvent(new Event('scroll')); frames(); frames();
assert.equal(properties.get('--forge-visible-top'), '25px', 'Viewport panning still moves the app and its portals');
assert.equal(scrolls, 1, 'Panning a focused field must not fight the user with focus scrolling');
doc.dispatchEvent(new Event('focusin')); frames(); frames();
assert.equal(scrolls, 2, 'Switching to a clipped input still reveals it without a viewport resize');
const panel = { overflowY: 'auto', parentElement: null, clientTop: 0, clientHeight: 200, getBoundingClientRect: () => ({ top: 25, bottom: 225 }) };
doc.activeElement.parentElement = panel;
doc.activeElement.box = { top: 160, bottom: 240 };
const beforeGrowth = scrolls;
doc.dispatchEvent(new Event('input')); frames(); frames();
assert.equal(scrolls, beforeGrowth + 1, 'Growing text clipped by the actual scroll panel is revealed even inside the visual viewport');
doc.activeElement.box = { top: 100, bottom: 150 };
doc.dispatchEvent(new Event('input')); frames(); frames();
assert.equal(scrolls, beforeGrowth + 1, 'Ordinary visible typing does not force scrolling');
viewport.dispatchEvent(new Event('scroll')); frames(); frames();
assert.equal(scrolls, beforeGrowth + 1, 'User scroll remains independent after a growth reveal');
Object.assign(viewport, { height: 150, scale: 2 });
viewport.dispatchEvent(new Event('resize')); doc.dispatchEvent(new Event('input')); frames(); frames();
assert.equal(scrolls, beforeGrowth + 1, 'Pinch zoom input does not force scrolling');
assert.equal(properties.get('--forge-visible-height'), '300px', 'Pinch zoom does not resize the application');
viewport.scale = 1;
viewport.dispatchEvent(new Event('resize'));
cleanup(); frames();
assert.equal(properties.size, 0, 'Unmount clears geometry and cancels queued callbacks');
const beforeUnmountedEvents = writes;
viewport.dispatchEvent(new Event('resize')); doc.dispatchEvent(new Event('focusin')); doc.dispatchEvent(new Event('input')); win.dispatchEvent(new Event('resize'));
frames();
assert.equal(writes, beforeUnmountedEvents, 'Unmount removes every viewport listener');
console.log('Keyboard viewport: keyboard clipping, frame coalescing, pinch zoom and unmount cleanup passed');
