import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/components/quotation/sheets/CustomerSwitcherSheet.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const phone = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/phone.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: phone });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = tree => tree == null || typeof tree === 'boolean' ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.props?.children);

function fixture() {
  const hooks = [], effects = [], requests = [];
  let cursor = 0, dirty = false, mounted = true, tree, staff = { id: 'employee', role: 'owner' }, allowed = true;
  const builder = { activeFloorId: 'first-floor', customerSwitcherOpen: true, customers: [], s: { customerId: null }, setCustomerSwitcherOpen(value) { builder.customerSwitcherOpen = value; dirty = true; } };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const slot = cursor++;
      hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, value => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }];
    },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useMemo(callback, deps) { const slot = cursor++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback(), deps }; return hooks[slot].value; },
    useEffect(callback, deps) {
      const slot = cursor++;
      if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); }); }
    },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: 'web' }, View: 'View', Pressable: 'Pressable', StyleSheet: { create: value => value } },
    '@/src/utils/phone': phone,
    '@/src/components/AppText': { Text: 'Text', TextInput: 'TextInput' },
    '@/src/components/BottomSheet': { BottomSheet: 'BottomSheet' }, '@/src/components/ui': { Button: 'Button' },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} }, '@/src/design/tokens': { color: {} },
    '@/src/state/auth': { useAuth: () => ({ staff }) },
    '@/src/hooks/use-permissions': { useActionAccess: () => allowed },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ floors: [{ id: 'ground-floor' }] }) },
    '@/src/team-delegation': { hasGrantAccess: () => allowed },
    '../context/BuilderContext': { useBuilder: () => builder },
    '@/src/api/client': { api: { get(path, options) { const pending = deferred(); requests.push({ path, options, ...pending }); return pending.promise; } } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {}, AbortController });
  const render = (flush = true) => { cursor = 0; dirty = false; tree = exports.CustomerSwitcherSheet(); if (flush) while (effects.length) effects.shift()(); return tree; };
  const find = id => nodes(tree).find(node => node.props?.testID === id);
  const settle = async (flush = true) => { for (let turn = 0; turn < 20; turn++) { await Promise.resolve(); if (dirty && mounted) render(flush); } };
  return {
    requests, render, find, settle, get text() { return text(tree); },
    async open() { render(); find('open-ground-floor-customers').props.onPress(); await settle(); },
    async retry() { find('retry-ground-floor-customers').props.onPress(); await settle(); },
    async close() { find('customer-switcher-sheet').props.onClose(); await settle(); },
    async reopen() { builder.customerSwitcherOpen = true; render(); find('open-ground-floor-customers').props.onPress(); await settle(); },
    changeScope({ floor = builder.activeFloorId, account = staff.id, access = allowed }, flush = true) { builder.activeFloorId = floor; staff = { ...staff, id: account }; allowed = access; render(flush); },
    unmount() { mounted = false; for (const hook of hooks) hook.cleanup?.(); },
  };
}
const sourceRow = name => [{ customer: { id: name, name } }];

test('empty Ground source list settles after one request and remains empty on unrelated renders', async () => {
  const f = fixture(); await f.open(); assert.equal(f.requests.length, 1);
  f.requests[0].resolve([]); await f.settle(); f.render(); await f.settle();
  assert.equal(f.requests.length, 1);
  assert.match(f.text, /No Ground Floor customer profiles available/);
  assert.doesNotMatch(f.text, /Loading Ground Floor/);
});

test('failed Ground sources show error and explicit Retry makes exactly one more request', async () => {
  const f = fixture(); await f.open();
  f.requests[0].reject({ detail: 'Fixture unavailable' }); await f.settle();
  assert.equal(f.requests.length, 1);
  assert.match(f.text, /Could not load Ground Floor customers/);
  assert.doesNotMatch(f.text, /No Ground Floor customer profiles available/);
  await f.retry(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(sourceRow('Recovered customer')); await f.settle();
  assert.match(f.text, /Recovered customer/);
  assert.doesNotMatch(f.text, /Could not load Ground Floor customers/);
});

test('closing aborts a pending read and reopening cannot publish its late result', async () => {
  const f = fixture(); await f.open(); const old = f.requests[0];
  await f.close(); assert.equal(old.options.signal.aborted, true);
  await f.reopen(); assert.equal(f.requests.length, 2);
  old.resolve(sourceRow('Stale customer')); await f.settle();
  assert.doesNotMatch(f.text, /Stale customer/);
  f.requests[1].resolve(sourceRow('Current customer')); await f.settle();
  assert.match(f.text, /Current customer/);
});

test('loaded source rows are retained without refetch until scope changes, then hidden immediately', async () => {
  const f = fixture(); await f.open();
  f.requests[0].resolve(sourceRow('Loaded customer')); await f.settle();
  f.render(); await f.settle();
  assert.equal(f.requests.length, 1); assert.match(f.text, /Loaded customer/);
  f.changeScope({ floor: 'other-floor' }, false);
  assert.doesNotMatch(f.text, /Loaded customer/);
  f.render(); await f.settle(); assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].options.floorId, 'other-floor');
});

for (const changed of [{ floor: 'other-floor' }, { account: 'other-employee' }]) {
  test(`changed ${Object.keys(changed)[0]} hides old rows and ignores responses before passive cleanup`, async () => {
    const f = fixture(); await f.open(); const old = f.requests[0];
    f.changeScope(changed, false); old.resolve(sourceRow('Prior scope')); await f.settle(false);
    assert.doesNotMatch(f.text, /Prior scope/);
    f.render(); await f.settle(); assert.equal(f.requests.length, 2);
    f.requests[1].resolve(sourceRow('New scope')); await f.settle();
    assert.match(f.text, /New scope/);
  });
}

test('A to B to A scope changes reject the first A response before passive cleanup', async () => {
  const f = fixture(); await f.open(); const old = f.requests[0];
  f.changeScope({ floor: 'other-floor' }, false); f.changeScope({ floor: 'first-floor' }, false);
  old.resolve(sourceRow('Obsolete A')); await f.settle(false);
  assert.doesNotMatch(f.text, /Obsolete A/);
  f.render(); await f.settle();
  assert.equal(f.requests.length, 2, 'Only the current A scope may start another request');
  assert.equal(f.requests[1].options.floorId, 'first-floor');
  f.unmount();
});

test('permission loss aborts and hides source rows, and unmount prevents publication', async () => {
  const f = fixture(); await f.open(); const old = f.requests[0];
  f.changeScope({ access: false }); await f.settle();
  assert.equal(old.options.signal.aborted, true);
  old.resolve(sourceRow('No longer permitted')); await f.settle();
  assert.doesNotMatch(f.text, /No longer permitted/);
  assert.equal(f.find('open-ground-floor-customers'), undefined);
  f.changeScope({ access: true }); await f.settle(); const current = f.requests.at(-1);
  f.unmount(); assert.equal(current.options.signal.aborted, true);
  current.resolve(sourceRow('Unmounted result')); await f.settle();
  assert.doesNotMatch(f.text, /Unmounted result/);
});
