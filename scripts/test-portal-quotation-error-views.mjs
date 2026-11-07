import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function renderScreen(file, items, error) {
  const result = { data: { items, total: items.length, has_more: false }, loading: false, refreshing: false, error, reload: async () => {} };
  const element = (type, props) => ({ type, props });
  const components = new Proxy({}, { get: (_target, name) => String(name) });
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    react: { useState: initial => [initial, () => {}], useEffect() {} },
    'react-native': { StyleSheet: { create: value => value }, View: 'View', Pressable: 'Pressable' },
    'expo-router': { useRouter: () => ({}) },
    '@/src/hooks/use-portal-quotations': { usePortalQuotations: () => result },
    '@/src/components/ui': components,
    '@/src/components/AppText': components,
    '@/src/components/customer/CustomerPortal': new Proxy({}, { get: (_target, name) => name === 'formatCustomerDate' ? value => value : String(name) }),
    '@/src/state/auth': { useAuth: () => ({ customer: { name: 'Fixture' } }) },
    '@/src/design/responsive': { useBp: () => ({ isPhone: true }) },
    '@/src/theme/tokens': { colors: {}, spacing: {}, type: {}, money: value => String(value) },
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => modules[id] || {} });
  return exports.default();
}
function descendants(node) {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!node || typeof node !== 'object') return [];
  return [node, ...descendants(node.props?.children)];
}
const quote = { id: 'one', number: 'Q-1', status: 'draft', grand_total: 100, item_count: 1, revision_count: 0, created_at: '2026-11-01' };
for (const items of [[], [quote]]) test(`portal refresh errors stay visible with ${items.length} retained quotations`, () => {
  const list = descendants(renderScreen('../app/(customer)/quotes/index.tsx', items, true));
  assert.ok(list.some(node => node.props?.accessibilityLabel === 'Retry loading quotations'));
  assert.equal(list.filter(node => node.props?.testID === 'quote-row-one').length, items.length);
  const home = descendants(renderScreen('../app/(customer)/home.tsx', items, true));
  assert.equal(home.filter(node => node.type === 'CustomerError').length, 1);
  assert.equal(home.filter(node => node.props?.testID === 'latest-quote-one').length, items.length);
});

test('successful empty portal views have no refresh failure controls', () => {
  const list = descendants(renderScreen('../app/(customer)/quotes/index.tsx', [], false));
  const home = descendants(renderScreen('../app/(customer)/home.tsx', [], false));
  assert.ok(list.some(node => node.type === 'CustomerEmpty'));
  assert.ok(home.some(node => node.type === 'CustomerEmpty'));
  assert.equal(list.filter(node => node.props?.accessibilityLabel === 'Retry loading quotations').length, 0);
  assert.equal(home.filter(node => node.type === 'CustomerError').length, 0);
});
