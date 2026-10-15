import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync('src/hooks/use-input-active.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function mount(platform) {
  let active = false;
  let cleanup;
  const events = new Map();
  const keyboard = new Map();
  let mutation;
  let disconnected = false;
  const document = { activeElement: null, body: {},
    addEventListener: (event, handler) => events.set(event, handler),
    removeEventListener: event => events.delete(event),
  };
  class Element { isConnected = true; matches() { return this.editable; } }
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, document, HTMLElement: Element, queueMicrotask, setTimeout, clearTimeout,
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    require: name => name === 'react' ? {
      useState: () => [active, value => { active = value; }],
      useEffect: effect => { cleanup = effect(); },
    } : { Platform: { OS: platform }, Keyboard: { addListener: (event, handler) => {
      keyboard.set(event, handler); return { remove: () => keyboard.delete(event) };
    } } },
  });
  module.exports.useInputActive();
  return { api: module.exports, active: () => active, document, events, keyboard,
    input: () => Object.assign(new Element(), { editable: true }), mutate: () => mutation(),
    disconnected: () => disconnected, cleanup: () => cleanup() };
}
const native = mount('ios');
const first = Symbol('first');
const second = Symbol('second');
assert.equal(native.active(), false);
native.api.reportInputFocus(first, true);
assert.equal(native.active(), true, 'hardware-keyboard focus hides chrome before keyboard events');
native.keyboard.get('keyboardDidShow')();
native.api.reportInputFocus(first, false);
assert.equal(native.active(), true, 'keyboard remains visible between focused fields');
native.api.reportInputFocus(second, true);
native.keyboard.get('keyboardDidHide')();
assert.equal(native.active(), true, 'dismissing software keyboard retains focused hardware entry');
native.api.reportInputFocus(second, false);
assert.equal(native.active(), false);
native.cleanup();
assert.equal(native.keyboard.size, 0);

const web = mount('web');
assert.equal(web.active(), false);
const removed = web.input();
web.document.activeElement = removed;
web.events.get('focusin')();
removed.isConnected = false;
web.document.activeElement = {};
web.mutate();
assert.equal(web.active(), true, 'input removal retains the blur tap-settlement delay');
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), false, 'removing the focused input without focusout restores chrome');
web.document.activeElement = web.input();
web.events.get('focusin')();
assert.equal(web.active(), true);
web.events.get('focusout')();
web.document.activeElement = web.input();
web.events.get('focusin')();
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), true, 'input-to-input transitions keep chrome hidden');
web.document.activeElement = { };
web.events.get('focusout')();
web.events.get('focusin')();
assert.equal(web.active(), true, 'focusing the tapped button cannot restore chrome before its click');
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), false);
web.document.activeElement = web.input();
web.events.get('focusout')();
web.cleanup();
assert.equal(web.disconnected(), true, 'unmount disconnects removal observation');
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), false, 'queued focus work cannot publish after unmount');
assert.equal(web.events.size, 0);
console.log('Input activity: web focus/transfer/unmount and native hardware/software keyboard lifecycle passed');
