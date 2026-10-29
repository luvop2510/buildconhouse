import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/utils/downloadFile.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// A transport may ignore abort (including stalled native response readers).
// The whole preparation must still settle, release its busy state and allow retry.
for (const phase of ['credentials', 'response', 'body', 'error-body']) {
  for (const cancellation of ['deadline', 'identity']) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const identity = new AbortController(), timers = new Map(), errors = [], clicks = [];
    let timerId = 0, settled = false;
    const loaded = { exports: {} };
    vm.runInNewContext(code, {
      module: loaded, exports: loaded.exports, AbortController, DOMException, Blob,
      navigator: { userAgent: 'Desktop Chrome' },
      document: { body: { appendChild() {} }, createElement: () => ({ click: () => clicks.push('download'), remove() {} }) },
      URL: { createObjectURL: () => 'blob:private-pdf', revokeObjectURL() {} },
      setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout: id => timers.delete(id),
      require: name => name === 'react-native' ? { Platform: { OS: 'web' } }
        : name.includes('Toast') ? { toast: { show: message => errors.push(message) } }
        : { api: { base: '' }, beginIdentityOperation: () => ({ signal: identity.signal, isCurrent: () => !identity.signal.aborted, finish() {} }),
          getToken: () => phase === 'credentials' ? held : Promise.resolve(null), getRequestFloorId: async () => 'ground-floor' },
      fetch: async () => phase === 'response' ? held : phase === 'error-body'
        ? { ok: false, status: 503, json: () => held }
        : { ok: true, blob: () => held },
    });
    const pending = loaded.exports.downloadApiFile('/quotations/fixture/pdf', 'Fixture.pdf').then(value => { settled = true; return value; });
    await nextTurn();
    const deadline = [...timers.values()].find(timer => timer.delay === 30_000);
    assert.ok(deadline, `${phase}: file preparation must have the ordinary 30-second request bound`);
    if (cancellation === 'deadline') deadline.callback();
    else identity.abort();
    await nextTurn();
    assert.equal(settled, true, `${phase}/${cancellation}: uncooperative pending work must release the caller`);
    assert.equal(await pending, false);
    assert.equal([...timers.values()].some(timer => timer.delay === 30_000), false, 'remove completed deadline');
    assert.equal(errors.length, cancellation === 'deadline' ? 1 : 0, 'identity changes cancel silently; timeout gives retry guidance');
    if (cancellation === 'deadline') assert.match(errors[0], /timed out.*try again/i);
    release(phase === 'response' ? { ok: true, blob: async () => new Blob(['%PDF']) }
      : phase === 'body' ? new Blob(['%PDF']) : phase === 'error-body' ? { detail: 'Late error' } : 'old-token');
    await nextTurn();
    assert.deepEqual(clicks, [], 'late work never opens an obsolete or timed-out file');
    assert.equal(errors.length, cancellation === 'deadline' ? 1 : 0);
  }
}
console.log('Download deadlines: credentials, response, body and error readers settle on timeout/identity cancellation without late publication.');

for (const aborted of [true, false]) {
  const loaded = { exports: {} }, identity = new AbortController(), unhandled = [];
  if (aborted) identity.abort();
  const observe = error => unhandled.push(error);
  process.on('unhandledRejection', observe);
  try {
    vm.runInNewContext(code, {
      module: loaded, exports: loaded.exports, AbortController, setTimeout, clearTimeout,
      require: name => name === 'react-native' ? { Platform: { OS: 'web' } }
        : name.includes('Toast') ? { toast: { show() {} } }
        : { beginIdentityOperation: () => ({ signal: identity.signal, isCurrent: () => !identity.signal.aborted, finish() {} }),
          getRequestFloorId: () => Promise.reject(new Error('Late floor hydration failure')),
          getToken: () => { throw new Error('Token hydration failed'); } },
      fetch: () => { throw new Error('Failed credentials must never reach transport'); },
    });
    assert.equal(await loaded.exports.downloadApiFile('/fixture.pdf', 'Fixture.pdf'), false);
    await nextTurn();
    assert.deepEqual(unhandled, [], 'observe credential failures even before an already-cancelled operation waits');
  } finally { process.off('unhandledRejection', observe); }
}
console.log('Download credential failures remain observed for active and already-cancelled identities.');
