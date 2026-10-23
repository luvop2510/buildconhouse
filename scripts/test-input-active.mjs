import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync('src/hooks/use-input-active.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function mount(platform, { deferCommit = false } = {}) {
  let active = false;
  const pending = [];
  const commit = () => { for (const next of pending.splice(0)) active = typeof next === 'function' ? next(active) : next; };
  let cleanup;
  const events = new Map();
  const windowEvents = new Map();
  const keyboard = new Map();
  let mutation;
  let disconnected = false;
  const document = { activeElement: null, body: {},
    addEventListener: (event, handler) => events.set(event, handler),
    removeEventListener: event => events.delete(event),
  };
  const window = {
    addEventListener: (event, handler) => windowEvents.set(event, handler),
    removeEventListener: event => windowEvents.delete(event),
  };
  class Element { isConnected = true; matches() { return this.editable; } }
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, document, window, HTMLElement: Element, queueMicrotask, setTimeout, clearTimeout,
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    require: name => name === './flush-input-restoration' ? { flushInputRestoration(update) {
      const adapter = ts.transpileModule(readFileSync(`src/hooks/flush-input-restoration${platform === 'web' ? '.web' : ''}.ts`, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const boundary = { exports: {} };
      vm.runInNewContext(adapter, { module: boundary, exports: boundary.exports, require: dependency => {
        assert.equal(dependency, 'react-dom');
        return { flushSync(callback) { callback(); commit(); } };
      } });
      boundary.exports.flushInputRestoration(update);
    } } : name === 'react' ? {
      useState: () => [active, value => { pending.push(value); if (!deferCommit) commit(); }],
      useEffect: effect => { cleanup = effect(); },
    } : { Platform: { OS: platform }, Keyboard: { addListener: (event, handler) => {
      keyboard.set(event, handler); return { remove: () => keyboard.delete(event) };
    } } },
  });
  module.exports.useInputActive();
  return { api: module.exports, active: () => active, document, events, windowEvents, keyboard,
    input: () => Object.assign(new Element(), { editable: true }), mutate: () => mutation(),
    commit, pendingCount: () => pending.length,
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
web.events.get('focusin')();
web.events.get('pointerdown')?.({ pointerId: 1 });
web.document.activeElement = {};
web.events.get('focusout')();
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), true, 'chrome stays hidden while the blur-triggering press is held');
web.events.get('pointerdown')?.({ pointerId: 2 });
web.windowEvents.get('pointerup')?.({ pointerId: 1 });
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), true, 'releasing one pointer does not move another active target');
web.windowEvents.get('pointercancel')?.({ pointerId: 2 });
assert.equal(web.active(), true, 'pointer cancellation retains click settlement');
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), false, 'the last pointer cancellation restores chrome after settlement');
web.document.activeElement = web.input();
web.events.get('focusin')();
web.events.get('pointerdown')?.({ pointerId: 3 });
web.document.activeElement = {};
web.events.get('focusout')();
web.windowEvents.get('blur')?.();
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), false, 'leaving the window cannot leave a stale pressed pointer');
web.document.activeElement = web.input();
web.events.get('focusout')();
web.cleanup();
assert.equal(web.disconnected(), true, 'unmount disconnects removal observation');
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(web.active(), false, 'queued focus work cannot publish after unmount');
assert.equal(web.events.size, 0);
assert.equal(web.windowEvents.size, 0);

// React can defer an ordinary timer's setState until the next pointer press.
// Restoration must finish inside its timer, before the next target is chosen.
const deferred = mount('web', { deferCommit: true });
deferred.document.activeElement = deferred.input();
deferred.events.get('focusin')(); deferred.commit();
assert.equal(deferred.active(), true);
deferred.document.activeElement = {};
deferred.events.get('focusout')();
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(deferred.active(), false, 'restore commits before the timer returns instead of remaining queued for a later click');
assert.equal(deferred.pendingCount(), 0, 'no stale chrome restoration may commit during the next press');
deferred.events.get('pointerdown')({ pointerId: 7 });
deferred.commit();
assert.equal(deferred.active(), false, 'the next target keeps the already-restored geometry');
deferred.windowEvents.get('pointerup')({ pointerId: 7 });
deferred.document.activeElement = deferred.input();
deferred.events.get('focusin')(); deferred.commit();
deferred.events.get('pointerdown')({ pointerId: 8 });
deferred.document.activeElement = {};
deferred.events.get('focusout')();
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(deferred.active(), true, 'restoration still waits through the entire active press');
deferred.windowEvents.get('pointerup')({ pointerId: 8 });
await new Promise(resolve => setTimeout(resolve, 170));
assert.equal(deferred.active(), false);
deferred.cleanup();
console.log('Input activity: web focus/transfer/unmount and native hardware/software keyboard lifecycle passed');
