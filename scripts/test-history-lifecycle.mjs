import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute actual source with controlled hooks. No network, tenant, DOM package,
// or app credentials are needed. Optional source paths support negative controls.
const historySource = readFileSync(process.argv[2] || new URL('../src/hooks/useHistory.ts', import.meta.url), 'utf8');
const overlaySource = readFileSync(process.argv[3] || new URL('../src/design/useOverlayFocus.ts', import.meta.url), 'utf8');
function execute(source, modules, globals = {}) {
  const exports = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in modules, `unexpected module: ${name}`);
    return modules[name];
  }, ...globals });
  return exports;
}

function historyFixture(replay) {
  const hooks = [], updates = [];
  let index = 0, now = 1000, api;
  const react = {
    useState(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      return [hooks[slot], update => updates.push(() => {
        const previous = hooks[slot];
        if (typeof update !== 'function') { hooks[slot] = update; return; }
        const next = update(previous);
        if (replay) {
          const repeated = update(previous);
          assert.equal(JSON.stringify(next), JSON.stringify(repeated), 'replayed transition must return the same state');
          hooks[slot] = repeated;
        } else hooks[slot] = next;
      })];
    },
    useRef(initial) { const slot = index++; return hooks[slot] ||= { current: initial }; },
    useCallback: callback => callback,
    useEffect() {},
  };
  const module = execute(historySource, { react }, { Date: { now: () => now } });
  const initial = { value: 0 };
  function render() { index = 0; api = module.useHistory(initial, { max: 2, coalesceMs: 800 }); }
  function flush() { while (updates.length) updates.shift()(); render(); }
  render();
  return {
    get api() { return api; }, initial, flush,
    apply(value, options) { api.apply(() => ({ value }), options); flush(); },
    tick(ms) { now += ms; },
  };
}

for (const replay of [false, true]) {
  const mode = replay ? 'updater replay' : 'normal updates';
  test(`history ${mode}: undo/redo stores one snapshot and respects the cap`, () => {
    const h = historyFixture(replay);
    h.apply(1); assert.equal(h.api.pastSize, 1);
    h.apply(2); h.apply(3); assert.equal(h.api.pastSize, 2);
    h.api.undo(); h.flush(); assert.equal(h.api.state.value, 2);
    h.api.undo(); h.flush(); assert.equal(h.api.state.value, 1);
    assert.equal(h.api.canUndo, false); assert.equal(h.api.canRedo, true);
    h.api.redo(); h.flush(); assert.equal(h.api.state.value, 2);
    h.api.redo(); h.flush(); assert.equal(h.api.state.value, 3);
    assert.equal(h.api.canRedo, false);
  });
  test(`history ${mode}: queued apply then undo then redo uses the latest document`, () => {
    const h = historyFixture(replay);
    h.api.apply(s => ({ value: s.value + 1 }));
    h.api.apply(s => ({ value: s.value + 1 }));
    h.api.undo(); h.api.redo(); h.flush();
    assert.equal(h.api.state.value, 2); assert.equal(h.api.pastSize, 2);
    assert.equal(h.api.canRedo, false);
  });
  test(`history ${mode}: undo queued before the edit commits reverses that edit`, () => {
    const h = historyFixture(replay);
    h.api.apply(s => ({ value: s.value + 1 }));
    h.api.undo(); h.flush();
    assert.equal(h.api.state.value, 0); assert.equal(h.api.pastSize, 0);
    assert.equal(h.api.canRedo, true);
    h.api.redo(); h.flush(); assert.equal(h.api.state.value, 1);
  });
  test(`history ${mode}: a new branch discards redo and a no-op preserves history`, () => {
    const h = historyFixture(replay);
    h.apply(1); h.apply(2); h.api.undo(); h.flush();
    h.api.apply(s => s); h.flush(); assert.equal(h.api.canRedo, true);
    h.apply(3); assert.equal(h.api.canRedo, false);
    h.api.undo(); h.flush(); assert.equal(h.api.state.value, 1);
  });
  test(`history ${mode}: coalescing uses matching keys and the strict time boundary`, () => {
    const h = historyFixture(replay);
    h.apply(1, { coalesceKey: 'notes' }); h.tick(799);
    h.apply(2, { coalesceKey: 'notes' }); assert.equal(h.api.pastSize, 1);
    h.tick(800); h.apply(3, { coalesceKey: 'notes' }); assert.equal(h.api.pastSize, 2);
    h.api.undo(); h.flush(); assert.equal(h.api.state.value, 2);
    h.api.reset(); h.flush();
    h.apply(4, { coalesceKey: 'notes' });
    h.apply(5, { coalesceKey: 'header' }); assert.equal(h.api.pastSize, 2);
  });
  test(`history ${mode}: hydration and non-document changes retain existing stack semantics`, () => {
    const h = historyFixture(replay);
    h.apply(1); h.api.undo(); h.flush();
    h.api.replace({ value: 7 }); h.flush();
    assert.equal(h.api.state.value, 7); assert.equal(h.api.pastSize, 0); assert.equal(h.api.canRedo, true);
    h.apply(8, { skipHistory: true });
    assert.equal(h.api.state.value, 8); assert.equal(h.api.pastSize, 0); assert.equal(h.api.canRedo, true);
    h.api.reset(); h.flush();
    assert.equal(h.api.state, h.initial); assert.equal(h.api.canUndo, false); assert.equal(h.api.canRedo, false);
  });
}

function overlayFixture() {
  const hooks = [], events = new Map(), frames = [];
  let index = 0, pending = [], timer, oldCalls = 0, newCalls = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const effect = (callback, deps) => {
    const slot = index++;
    if (!same(hooks[slot]?.deps, deps)) pending.push(() => {
      hooks[slot]?.cleanup?.();
      hooks[slot] = { deps, cleanup: callback() };
    });
  };
  const react = {
    useRef(initial) { const slot = index++; return hooks[slot] ||= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect,
  };
  const previous = { isConnected: true, focus() { document.activeElement = this; } };
  const returnFocusRef = { current: previous };
  const input = { focus() { document.activeElement = this; }, getClientRects: () => [{}], getAttribute: () => null };
  const panel = { contains: target => target === input || target === panel,
    querySelectorAll: () => [input], focus() { document.activeElement = this; } };
  const document = { body: { children: [] }, activeElement: previous,
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: (name, callback) => { if (events.get(name) === callback) events.delete(name); },
  };
  const module = execute(overlaySource, { react, 'react-native': { Platform: { OS: 'web' } } }, {
    document, HTMLElement: class {}, setTimeout: callback => { timer = callback; return 1; }, clearTimeout: () => { timer = null; },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
  });
  function render(close, dismissable = true, open = true, explicitTrigger = false) {
    index = 0; pending = [];
    module.useOverlayFocus(open, close, dismissable, explicitTrigger ? returnFocusRef : undefined).current = panel;
  }
  function commit() { for (const apply of pending) apply(); pending = []; if (timer) { const run = timer; timer = null; run(); } }
  return { render, commit, events, previous, document, returnFocusRef,
    flushFrames() { const pendingFrames = frames.splice(0); for (const frame of pendingFrames) frame(); },
    old: () => oldCalls++, newer: () => newCalls++,
    get calls() { return [oldCalls, newCalls]; },
    setPanelConnected(value) { panel.isConnected = value; },
    escape() { events.get('keyup')?.({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} }); },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('overlay callback updates only after commit, including an abandoned render', () => {
  const h = overlayFixture();
  h.render(h.old); h.commit(); h.escape();
  h.render(h.newer); h.escape(); assert.deepEqual(h.calls, [2, 0]);
  // Discard the uncommitted render, then commit a later one.
  h.render(h.old); h.commit(); h.escape(); assert.deepEqual(h.calls, [3, 0]);
  h.render(h.newer); h.commit(); h.escape(); assert.deepEqual(h.calls, [3, 1]);
  h.unmount();
});

test('overlay dismissal policy updates only after commit', () => {
  const h = overlayFixture();
  h.render(h.old); h.commit();
  h.render(h.newer, false); h.escape(); assert.deepEqual(h.calls, [1, 0]);
  h.commit(); h.escape(); assert.deepEqual(h.calls, [1, 0]);
  h.render(h.newer, true); h.commit(); h.escape(); assert.deepEqual(h.calls, [1, 1]);
  h.unmount();
});

test('overlay cleanup removes listeners and restores the trigger on close and unmount', () => {
  const h = overlayFixture();
  h.render(h.old); h.commit(); assert.equal(h.events.size, 2);
  h.render(h.old, true, false); h.commit();
  h.flushFrames();
  assert.equal(h.events.size, 0); assert.equal(h.document.activeElement, h.previous);
  h.render(h.old); h.commit(); h.unmount();
  h.flushFrames();
  assert.equal(h.events.size, 0); assert.equal(h.document.activeElement, h.previous);
});

test('an autoFocus child cannot replace an explicit overlay trigger', () => {
  const h = overlayFixture();
  h.document.activeElement = { isConnected: true, focus() {} }; // child autoFocus before parent effects
  h.render(h.old, true, true, true); h.commit(); h.render(h.old, true, false); h.commit(); h.flushFrames();
  assert.equal(h.document.activeElement, h.previous);
  h.unmount(); assert.equal(h.events.size, 0);
});

test('focus restoration waits until the closing native web portal releases its trap', () => {
  const h = overlayFixture();
  h.render(h.old, true, true, true); h.commit(); h.setPanelConnected(true);
  h.render(h.old, true, false); h.commit(); h.flushFrames();
  assert.notEqual(h.document.activeElement, h.previous);
  h.setPanelConnected(false); h.flushFrames();
  assert.equal(h.document.activeElement, h.previous);
  h.unmount(); assert.equal(h.events.size, 0);
});

test('overlay restores the live explicit trigger after responsive replacement', () => {
  const h = overlayFixture();
  h.render(h.old, true, true, true); h.commit();
  h.previous.isConnected = false;
  const replacement = { isConnected: true, focus() { h.document.activeElement = this; } };
  h.returnFocusRef.current = replacement;
  h.render(h.old, true, false, true); h.commit(); h.flushFrames();
  assert.equal(h.document.activeElement, replacement);
  h.unmount();
});

test('overlay restoration runs after native Modal cleanup changes focus', () => {
  const h = overlayFixture();
  h.render(h.old); h.commit();
  h.render(h.old, true, false); h.commit();
  const backdrop = {};
  h.document.activeElement = backdrop; // React Native Web's unmount cleanup.
  assert.equal(h.document.activeElement, backdrop);
  h.flushFrames();
  assert.equal(h.document.activeElement, h.previous);
});

test('overlay restoration preserves destination focus after its trigger is removed', () => {
  const h = overlayFixture();
  h.render(h.old); h.commit();
  h.render(h.old, true, false); h.commit();
  h.previous.isConnected = false;
  const destination = {};
  h.document.activeElement = destination;
  h.flushFrames();
  assert.equal(h.document.activeElement, destination);
});

test('closing an overlay cannot steal focus from the next form field before text insertion', () => {
  const h = overlayFixture();
  h.render(h.old, true, true, true); h.commit(); h.setPanelConnected(true);
  h.render(h.old, true, false, true); h.commit(); h.flushFrames();
  // The native portal releases its trap, then focus reaches a background field
  // before the pending restoration frame. Browser fill/paste inserts text next.
  h.setPanelConnected(false);
  const destination = { isConnected: true, value: '', focus() { h.document.activeElement = this; } };
  destination.focus();
  h.flushFrames();
  assert.equal(h.document.activeElement, destination, 'restoration must preserve the newly focused field');
  h.document.activeElement.value = 'Showroom cabinets and worktop';
  assert.equal(destination.value, 'Showroom cabinets and worktop');
  h.unmount();
});
