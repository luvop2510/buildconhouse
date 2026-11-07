import './test-portal-quotation-error-views.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/hooks/use-portal-quotations.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const payload = id => ({ items: [{ id, number: id, item_count: 100, revision_count: 5 }], total: 205, has_more: true });
function fixture() {
  const hooks = [], effects = [], requests = [];
  let slot = 0, dirty = false, state, customerId = 'customer-a', page = 0, query = '', limit = 20;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) { const i = slot++; hooks[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, next => { hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next; dirty = true; }]; },
    useRef(initial) { return hooks[slot++] ||= { current: initial }; },
    useMemo(fn, deps) { const i = slot++; if (!same(hooks[i]?.deps, deps)) hooks[i] = { value: fn(), deps }; return hooks[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = slot++; if (!same(hooks[i]?.deps, deps)) { const cleanup = hooks[i]?.cleanup; hooks[i] = { deps }; effects.push(() => { cleanup?.(); hooks[i].cleanup = fn(); }); } },
  };
  const modules = {
    react, '@/src/state/auth': { useAuth: () => ({ customer: { id: customerId } }) },
    '@/src/api/client': { api: { get(path, options) { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); requests.push({ path, options, resolve, reject }); return promise; } } },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => modules[id], URLSearchParams, AbortController });
  const render = () => { slot = 0; dirty = false; state = exports.usePortalQuotations(limit, page, query); while (effects.length) effects.shift()(); };
  render();
  return {
    requests, get state() { return state; },
    change(values) { ({ customerId = customerId, page = page, query = query, limit = limit } = values); render(); },
    unmount() { hooks.forEach(hook => hook.cleanup?.()); },
    async settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } },
  };
}

test('portal pages fetch bounded summaries and latest home requests only one', async () => {
  const h = fixture();
  assert.equal(h.requests[0].path, '/portal/quotations/page?limit=20&skip=0');
  h.requests[0].resolve(payload('first')); await h.settle();
  assert.equal(h.state.data.total, 205);
  h.change({ page: 1 });
  assert.equal(h.state.data, null, 'previous page is hidden synchronously');
  assert.equal(h.requests[1].path, '/portal/quotations/page?limit=20&skip=20');
  h.change({ page: 0, query: 'Q-204' });
  assert.equal(h.requests[1].options.signal.aborted, true);
  assert.equal(h.requests[2].path, '/portal/quotations/page?limit=20&skip=0&q=Q-204');
  h.requests[2].resolve(payload('match')); await h.settle();
  h.requests[1].resolve(payload('obsolete-page')); await h.settle();
  assert.equal(h.state.data.items[0].id, 'match');
  h.change({ limit: 1, query: '' });
  assert.equal(h.requests.at(-1).path, '/portal/quotations/page?limit=1&skip=0');
  h.unmount();
});

test('refresh retains current summaries on failure and latest response wins', async () => {
  const h = fixture(); h.requests[0].resolve(payload('original')); await h.settle();
  const firstRefresh = h.state.reload(); await h.settle();
  assert.equal(h.state.refreshing, true);
  assert.equal(h.state.data.items[0].id, 'original');
  const secondRefresh = h.state.reload();
  assert.equal(h.requests[1].options.signal.aborted, true);
  h.requests[2].reject(new Error('temporary outage')); await secondRefresh; await h.settle();
  assert.equal(h.state.error, true);
  assert.equal(h.state.refreshing, false);
  assert.equal(h.state.data.items[0].id, 'original');
  h.requests[1].resolve(payload('stale')); await firstRefresh; await h.settle();
  assert.equal(h.state.data.items[0].id, 'original');
  const retry = h.state.reload(); h.requests[3].resolve(payload('fresh')); await retry; await h.settle();
  assert.equal(h.state.error, false);
  assert.equal(h.state.data.items[0].id, 'fresh');
  h.unmount();
});

test('account transitions and unmount block stale reads and callbacks', async () => {
  const h = fixture(), oldReload = h.state.reload;
  h.change({ customerId: 'customer-b' });
  assert.equal(h.requests[0].options.signal.aborted, true);
  await oldReload(); assert.equal(h.requests.length, 2);
  h.requests[0].resolve(payload('private-a')); h.requests[1].resolve(payload('private-b')); await h.settle();
  assert.equal(h.state.data.items[0].id, 'private-b');
  const latestReload = h.state.reload;
  h.unmount(); await latestReload();
  assert.equal(h.requests.length, 2);
});
