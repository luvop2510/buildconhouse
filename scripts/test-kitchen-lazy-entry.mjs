import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

for (const component of ['KitchenWorkspace', 'KitchenProjectDetail']) {
  let load, reads = 0, failure;
  const screen = () => null;
  const deferredScreen = Symbol('deferred screen');
  const modules = {
    react: { lazy: loader => { load = loader; return deferredScreen; }, Suspense: 'suspense' },
    'react-native': { ActivityIndicator: 'spinner', View: 'view' },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
  };
  const output = {};
  const source = readFileSync(new URL(`../src/components/kitchen/Lazy${component}.tsx`, import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports: output,
    require: name => {
      if (name !== `./${component}`) {
        assert.ok(name in modules, `Unexpected eager dependency ${name}`);
        return modules[name];
      }
      reads += 1;
      if (failure) throw failure;
      return { [component]: screen };
    },
  });
  assert.equal(reads, 0, 'Importing the route wrapper does not fetch or evaluate the editor');
  const props = { page: 'stage', stage: 'cad', section: 'history' };
  const tree = output[`Lazy${component}`](props);
  assert.equal(reads, 0, 'The wrapper leaves loading to React Suspense');
  assert.equal(tree.type, 'suspense');
  assert.equal(tree.props.children.type, deferredScreen);
  assert.deepEqual({ ...tree.props.children.props }, props, 'Route identity reaches the deferred screen unchanged');
  assert.equal(tree.props.fallback.props.children.type, 'spinner', 'A pending download has a visible fallback');
  assert.equal((await load()).default, screen, 'The named screen resolves as the lazy default');
  failure = new Error('fixture module download failed');
  await assert.rejects(load(), error => error === failure, 'Module failures reach the existing route recovery boundary');
}

console.log('Kitchen lazy entries defer editors, preserve route props and propagate module failures');
