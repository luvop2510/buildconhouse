import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(process.argv[2] || new URL('../src/components/PageErrorBoundary.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function harness(browser = true) {
  const exports = {}, navigations = [], errors = [];
  let reloads = 0, homeCalls = 0;
  const browserWindow = { location: { reload() { reloads++; }, assign(href) { navigations.push(href); } }, __FORGE_IS_RELEASE_ERROR__: error => error.name === 'AsyncRequireError' };
  class Component { constructor(props) { this.props = props; } setState(change) { this.state = { ...this.state, ...change }; } }
  const modules = {
    react: { Component }, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: browser ? 'web' : 'ios' }, Pressable: 'button', View: 'view', StyleSheet: { create: value => value } },
    'expo-router': {}, '@/src/components/AppText': { Text: 'text' }, '@/src/state/auth': {}, '@/src/hooks/use-floor-access': {}, '@/src/access-profiles': {},
    '@/src/lib/monitoring': { captureRuntimeError: error => errors.push(error) },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} },
  };
  vm.runInNewContext(compiled, { exports, window: browserWindow, require: name => { assert.ok(modules[name], name); return modules[name]; } });
  const boundary = new exports.PageErrorBoundary({ children: 'page', resetKey: '/dashboard:first-floor', homeHref: '/dashboard', onHome: () => { homeCalls++; } });
  const fail = (name = 'TypeError') => { boundary.state = { ...boundary.state, ...exports.PageErrorBoundary.getDerivedStateFromError() }; boundary.componentDidCatch(Object.assign(new Error('fixture failure'), { name })); };
  const nodes = element => [element, ...(Array.isArray(element?.props?.children) ? element.props.children : [element?.props?.children]).filter(Boolean).flatMap(child => typeof child === 'object' ? nodes(child) : [child])];
  return { boundary, fail, nodes: () => nodes(boundary.render()), get reloads() { return reloads; }, get homeCalls() { return homeCalls; }, navigations, errors };
}

test('a repeated render failure offers a real reload instead of an endless failed remount', () => {
  const app = harness(); app.fail();
  app.nodes().find(node => node?.props?.accessibilityLabel === 'Try opening this page again').props.onPress();
  assert.equal(app.boundary.state.failed, false);
  app.fail();
  const reload = app.nodes().find(node => node?.props?.accessibilityLabel === 'Reload app');
  assert.ok(reload, 'An unsuccessful retry must provide a new recovery path');
  reload.props.onPress(); assert.equal(app.reloads, 1);
});

test('Open home leaves the poisoned lazy-module tree even when already on the home route', () => {
  const app = harness(); app.fail('AsyncRequireError');
  app.nodes().find(node => node?.props?.accessibilityLabel === 'Open workspace home').props.onPress();
  assert.deepEqual(app.navigations, ['/dashboard']);
  assert.equal(app.reloads, 0);
  assert.equal(app.homeCalls, 0);
});

test('a failed module explains the connection recovery without claiming a new release exists', () => {
  const app = harness(); app.fail('AsyncRequireError');
  assert.doesNotMatch(app.nodes().filter(node => typeof node === 'string').join(' '), /app update is available/i);
  assert.match(app.nodes().filter(node => typeof node === 'string').join(' '), /connection/i);
  assert.equal(app.errors.length, 1);
  assert.equal(app.reloads, 0, 'A caught module error cannot discard mounted work automatically');
});

test('native home navigation and route reset retain their existing contracts', () => {
  const app = harness(false); app.fail();
  app.nodes().find(node => node?.props?.accessibilityLabel === 'Open workspace home').props.onPress();
  assert.equal(app.homeCalls, 1);
  const next = app.boundary.constructor.getDerivedStateFromProps({ resetKey: '/customers:first-floor' }, app.boundary.state);
  assert.equal(next.failed, false);
  app.nodes().find(node => node?.props?.accessibilityLabel === 'Try opening this page again').props.onPress();
  app.fail();
  assert.ok(app.nodes().find(node => node?.props?.accessibilityLabel === 'Try opening this page again'));
  assert.equal(app.reloads, 0);
});
