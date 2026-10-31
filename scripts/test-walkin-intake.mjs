import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { formatPhone } from '../src/utils/phone.ts';

const source = readFileSync(new URL('../app/(admin)/walkins/new.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(floorId) {
  const hooks = [], effects = [], writes = [], navigation = [], timers = new Map();
  const floors = [{ id: floorId, name: 'Selected floor' }];
  let cursor = 0, dirty = false, tree, nextTimer = 0, failure = null;
  let duplicateMatches = { high: [], medium: [], low: [] };
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const react = {
    useState(initial) {
      const slot = cursor++;
      hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, value => {
        const next = typeof value === 'function' ? value(hooks[slot].value) : value;
        if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; }
      }];
    },
    useMemo(callback, deps) {
      const slot = cursor++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback(), deps };
      return hooks[slot].value;
    },
    useEffect(callback, deps) {
      const slot = cursor++;
      if (!same(hooks[slot]?.deps, deps)) {
        const cleanup = hooks[slot]?.cleanup;
        hooks[slot] = { deps };
        effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
      }
    },
  };
  const jsx = (type, props) => ({ type, props });
  const ui = Object.fromEntries(['Alert', 'Avatar', 'Button', 'Card', 'Chip', 'ListRow', 'PageHeader', 'SearchField', 'Sheet', 'TextField'].map(name => [name, name]));
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'web' }, ScrollView: 'ScrollView', View: 'View', KeyboardAvoidingView: 'KeyboardAvoidingView', StyleSheet: { create: x => x, hairlineWidth: 1 } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { useLocalSearchParams: () => ({}), useRouter: () => ({ replace: path => navigation.push(path), push() {}, back() {} }) },
    '@/src/components/AppText': { Text: 'Text' },
    '@/src/utils/phone': { formatPhone },
    '@/src/components/ui': ui,
    '@/src/design/Disclosure': { Disclosure: 'Disclosure' },
    '@/src/components/leads/LeadScopeFields': { LeadScopeFields: 'LeadScopeFields' },
    '@/src/design/responsive': { useBp: () => ({ isPhone: true }) },
    '@/src/hooks/use-floor-access': { useFloorAccess: () => ({ floors, selectedFloorId: floorId }) },
    '@/src/state/auth': { useAuth: () => ({ staff: { id: 'owner', role: 'owner' } }) },
    '@/src/team-delegation': { hasGrantAccess: () => true },
    '@/src/theme/tokens': { colors: {}, spacing: {}, type: {} },
    '@/src/components/Toast': { toast: { success() {}, error() {} } },
    '@/src/api/walkins': {
      parseDuplicateConflict: () => null,
      walkinsApi: {
        listSources: async () => ({ sources: ['Walk-in', 'Reference'] }),
        listAssignees: async () => [],
        checkDuplicate: async () => duplicateMatches,
        async create(body) { writes.push(plain(body)); if (failure) throw { detail: failure }; return { id: 'saved', floor_id: floorId }; },
      },
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => modules[name] || {},
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
  });
  const render = () => { cursor = 0; dirty = false; tree = exports.default(); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } };
  function nodes(node = tree) { return [node, ...(Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).flat(Infinity).filter(Boolean).flatMap(child => typeof child === 'object' ? nodes(child) : [])]; }
  const byId = id => { const node = nodes().find(node => node?.props?.testID === id); assert.ok(node, id); return node.props; };
  render();
  return {
    writes, navigation, settle, nodes, byId,
    async fill(id, value) { byId(id).onChangeText(value); await settle(); },
    async assign() { const scope = nodes().find(node => node?.type === 'LeadScopeFields').props; scope.onChange({ ...scope.value, assignments: [{ floor_id: floorId, user_id: 'worker', user_name: 'Worker' }] }); await settle(); },
    fail(message) { failure = message; },
    async matches(value) { duplicateMatches = value; for (const callback of timers.values()) callback(); timers.clear(); await settle(); },
    async save() { await byId('walkin-save-btn').onPress(); await settle(); },
  };
}

for (const floorId of ['ground-floor', 'first-floor', 'third-floor']) {
  test(`${floorId} intake exposes only name, phone and address, retaining required assignment`, async () => {
    const f = fixture(floorId); await f.settle();
    assert.deepEqual(f.nodes().filter(node => node?.type === 'TextField').map(node => node.props.testID), ['walkin-name', 'walkin-phone', 'walkin-address']);
    const scope = f.nodes().find(node => node?.type === 'LeadScopeFields').props;
    assert.equal(scope.assignmentsRequired, true);
    assert.equal(scope.reference, false);
    assert.equal(scope.onPartnerChange, undefined);
    await f.fill('walkin-name', ' Customer '); await f.fill('walkin-phone', '9000000000'); await f.assign();
    await f.save(); assert.equal(f.writes.length, 0);
    assert.equal(f.byId('walkin-submit-error').children, 'Address is required');
    assert.equal(f.byId('walkin-address').error, 'Address is required');
    await f.fill('walkin-address', ' 12 Showroom Road, Mumbai '); await f.save();
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0], { customer_name: 'Customer', customer_phone: '9000000000', address: '12 Showroom Road, Mumbai', source: 'Walk-in', salesperson_id: 'worker', floor_id: floorId,
      interested_floor_ids: [floorId], assignments: [{ floor_id: floorId, user_id: 'worker', user_name: 'Worker' }], force_new_customer: false });
    assert.deepEqual(f.navigation, [`/(admin)/walkins/saved?floor_id=${floorId}`]);
  });
}

test('failed save preserves the three fields and explicit existing-customer selection for retry', async () => {
  const f = fixture('first-floor'); await f.settle();
  await f.fill('walkin-name', 'Returning customer'); await f.fill('walkin-phone', '9000000000');
  await f.fill('walkin-address', '12 Showroom Road'); await f.assign();
  await f.matches({ high: [], medium: [{ id: 'existing', name: 'Returning customer' }], low: [] });
  f.byId('walkin-use-existing-existing').onPress(); await f.settle();
  f.fail('Please retry'); await f.save();
  assert.equal(f.byId('walkin-submit-error').children, 'Please retry');
  assert.equal(f.byId('walkin-name').value, 'Returning customer');
  assert.equal(f.byId('walkin-phone').value, '9000000000');
  assert.equal(f.byId('walkin-address').value, '12 Showroom Road');
  assert.equal(f.navigation.length, 0);
  f.fail(null); await f.save();
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[0], f.writes[1]);
  assert.equal(f.writes[1].use_existing_customer_id, 'existing');
  assert.equal(f.navigation.length, 1);
});
