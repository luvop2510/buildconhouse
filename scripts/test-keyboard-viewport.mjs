import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

for (const file of ['../app/_layout.tsx', '../app/_layout.web.tsx']) assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /useKeyboardViewport\(\)/);
const source = readFileSync(new URL('../src/hooks/use-keyboard-viewport.ts', import.meta.url), 'utf8');
const viewport = new EventTarget(); Object.assign(viewport, { height: 1024, offsetTop: 0, scale: 1 });
const win = new EventTarget(); win.visualViewport = viewport;
let styleReads = 0, scrollWrites = 0;
win.getComputedStyle = element => { styleReads++; return { overflowY: element.overflowY || 'visible' }; };
const doc = new EventTarget(), properties = new Map();
let writes = 0, cleanup;
doc.documentElement = { style: { setProperty: (key, value) => { writes++; properties.set(key, value); }, removeProperty: key => properties.delete(key) } };
doc.body = { overflowY: 'hidden', parentElement: null, clientTop: 0, clientHeight: 1024, scrollHeight: 1800, scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
const panel = { overflowY: 'auto', parentElement: doc.body, clientTop: 0, clientHeight: 1000, scrollHeight: 1800, scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
let panelScrollTop = 0;
Object.defineProperty(panel, 'scrollTop', { get: () => panelScrollTop, set: value => { scrollWrites++; panelScrollTop = value; } });
class Input {
  parentElement = panel;
  box = { top: 40, bottom: 90 };
  matches() { return true; }
  getBoundingClientRect() { const top = this.box.top - panel.scrollTop, bottom = this.box.bottom - panel.scrollTop; return { top, bottom, height: bottom - top }; }
  scrollIntoView() { assert.fail('Never pan the document or hidden application root'); }
}
doc.activeElement = new Input();
const callbacks = new Map(); let nextFrame = 0;
const frames = () => { for (const [id, callback] of [...callbacks]) { callbacks.delete(id); callback(); } };
const flush = () => { frames(); frames(); };
const exports = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
  exports, window: win, document: doc, HTMLElement: Input,
  requestAnimationFrame: callback => { const id = ++nextFrame; callbacks.set(id, callback); return id; }, cancelAnimationFrame: id => callbacks.delete(id),
  require: name => name === 'react' ? { useEffect: effect => { cleanup = effect(); } } : { Platform: { OS: 'web' } },
});
exports.useKeyboardViewport(); flush();
assert.equal(properties.get('--forge-visible-height'), '1024px'); assert.equal(panel.scrollTop, 0);
Object.assign(viewport, { height: 300, offsetTop: 20 }); doc.activeElement.box = { top: 700, bottom: 750 };
const beforeBurst = writes;
for (let i = 0; i < 30; i++) { viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); }
assert.equal(callbacks.size, 1); flush();
assert.equal(writes - beforeBurst, 2); assert.equal(properties.get('--forge-visible-top'), '20px');
assert.equal(panel.scrollTop, 438, 'Reveal only the clipped distance, retaining eight-pixel margin');
assert.equal(doc.body.scrollTop, 0, 'Body remains anchored');
const stable = panel.scrollTop, afterResize = writes;
const beforeTypingStyles = styleReads, beforeTypingScrolls = scrollWrites;
for (let i = 0; i < 3; i++) { viewport.dispatchEvent(new Event('scroll')); doc.dispatchEvent(new Event('input')); flush(); }
assert.equal(panel.scrollTop, stable, 'Visible typing does not bounce the field'); assert.equal(writes, afterResize);
assert.equal(styleReads - beforeTypingStyles, 6, 'Read ancestor styles once per reveal, including the non-scrollable body');
assert.equal(scrollWrites, beforeTypingScrolls, 'Visible keystrokes must not issue no-op scroll writes');
viewport.offsetTop = 25; viewport.dispatchEvent(new Event('scroll')); flush();
assert.equal(panel.scrollTop, stable, 'User panning never triggers automatic reveal');
panel.clientHeight = 200; panel.getBoundingClientRect = () => ({ top: 25 }); panel.scrollTop = 0;
doc.activeElement.box = { top: 160, bottom: 240 }; doc.dispatchEvent(new Event('input')); flush();
assert.equal(panel.scrollTop, 23, 'Nested scrollport clipping participates in reveal');
panel.scrollTop = 0; doc.activeElement.box = { top: 160, bottom: 760 }; doc.dispatchEvent(new Event('input')); flush();
const tallPosition = panel.scrollTop;
for (let i = 0; i < 5; i++) { doc.dispatchEvent(new Event('input')); flush(); }
assert.equal(panel.scrollTop, tallPosition, 'A tall field anchors its top instead of alternating between edges');
Object.assign(viewport, { height: 150, scale: 2 }); viewport.dispatchEvent(new Event('resize')); doc.dispatchEvent(new Event('input')); flush();
assert.equal(panel.scrollTop, tallPosition); assert.equal(properties.get('--forge-visible-height'), '300px', 'Pinch zoom retains ordinary browser pan/zoom');
viewport.scale = 1; viewport.dispatchEvent(new Event('resize')); cleanup(); flush();
assert.equal(properties.size, 0); const finalWrites = writes;
viewport.dispatchEvent(new Event('resize')); doc.dispatchEvent(new Event('focusin')); doc.dispatchEvent(new Event('input')); win.dispatchEvent(new Event('resize')); flush();
assert.equal(writes, finalWrites);
console.log('Keyboard viewport: minimal container-only reveal, stable typing/tall fields, clipping, frame coalescing, pinch zoom and cleanup passed.');

// Render the actual shared input and shell with native platform primitives.
function renderModule(path, platform) {
  const result = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, {
    module: result, exports: result.exports,
    require: name => name === 'react' ? { forwardRef: render => render, useRef: value => ({ current: value }), useEffect() {} }
      : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx }
      : name === 'react-native' ? { Platform: { OS: platform }, StyleSheet: { flatten: value => value }, Text: 'Text', TextInput: 'TextInput', View: 'View' }
      : name === 'react-native-safe-area-context' ? { SafeAreaView: 'SafeAreaView' }
      : name.endsWith('appTextFamily') ? { appTextFamily: () => 'System' }
      : name.endsWith('use-input-active') ? { reportInputFocus() {} }
      : { color: {}, layout: {} },
  });
  return result.exports;
}
for (const platform of ['android', 'ios', 'web']) {
  const input = renderModule('../src/components/AppText.tsx', platform).TextInput;
  assert.equal(input({ value: 'Visible draft' }, null).props.disableFullscreenUI, platform === 'android', 'Android entry stays in the actual field instead of the IME fullscreen editor');
  assert.equal(input({ disableFullscreenUI: false }, null).props.disableFullscreenUI, false, 'Preserve an explicit native caller override');
  const { AppScaffold } = renderModule('../src/components/mobile/AppScaffold.tsx', platform);
  const navigation = { key: 'same-mounted-navigation' };
  const hidden = AppScaffold({ bottomNavigation: navigation, bottomNavigationHidden: true }).props.children[1];
  assert.equal(hidden.props.children, navigation);
  assert.equal(hidden.props.style[1].position, 'absolute', 'Hidden navigation releases its height on native Android as well as web');
  assert.equal(hidden.props.pointerEvents, 'none');
  assert.equal(hidden.props['aria-hidden'], true);
  const visible = AppScaffold({ bottomNavigation: navigation }).props.children[1];
  assert.equal(visible.props.style[1], null);
}
const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
assert.equal(config.expo.android.softwareKeyboardLayoutMode, 'resize');
assert.doesNotMatch(readFileSync(new URL('../app/+html.tsx', import.meta.url), 'utf8'), /interactive-widget=/, 'Static HTML must also parse without warnings on older Safari');
assert.match(readFileSync(new URL('./release-recovery.js', import.meta.url), 'utf8'), /interactive-widget=resizes-content/);
console.log('Android shared entry: fullscreen IME disabled by default, hidden navigation leaves no blank band, native and Chrome viewport resizing configured.');
