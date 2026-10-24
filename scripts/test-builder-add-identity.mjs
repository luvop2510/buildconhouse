import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { addProductAndConcealedPart } from '../src/components/quotation/helpers/concealedParts.ts';

// Evaluate the production callback initializer, so whole-history dependencies
// cannot silently invalidate every memoized product card after adding one line.
const source = readFileSync(new URL('../src/components/quotation/context/BuilderContext.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('BuilderContext.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer;
const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'addFromProduct') initializer = node.initializer.getText(tree); ts.forEachChild(node, visit); };
visit(tree);
assert(initializer);
const body = ts.transpileModule(`const applyHistory = history.apply; exports.callback = ${initializer};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
let previous, state = { lines: [], activeRoom: 'Bathroom' };
const apply = mutator => { state = mutator(state); };
const categories = { basin: 'Basins' };
const render = (history, categoryById) => {
  const output = {};
  vm.runInNewContext(body, { exports: output, history, categoryById,
    useCallback(callback, deps) {
      if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) previous = { callback, deps };
      return previous.callback;
    },
    catalogPriceUnknown: () => false, Haptics: { selectionAsync() {} }, playAddProductSound() {},
    productImageList: () => [], addProductAndConcealedPart, suggestedProductArea: (_name, category) => category,
  });
  return output.callback;
};
const first = render({ apply, state }, categories);
const product = { id: 'basin-1', sku: 'B1', name: 'Basin', price: 100, mrp: 120, category_id: 'basin', variants: [] };
first(product);
assert.equal(state.lines[0].qty, 1);
const next = render({ apply, state, canUndo: true }, categories);
assert.equal(next, first, 'Adding a line must preserve the handler shared by every memoized catalog card');
next(product);
assert.equal(state.lines[0].qty, 2);
assert.equal(state.lines.length, 1);
const recategorized = render({ apply, state }, { basin: 'Updated basins' });
assert.notEqual(recategorized, next, 'New categories must refresh the handler rather than retaining stale classification');
recategorized({ ...product, id: 'basin-2', sku: 'B2' });
assert.equal(state.lines[1].area, 'Updated basins');
console.log('Actual builder product-add handler retains card identity across line/history edits and refreshes category classification.');
