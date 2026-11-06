import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const dates = {};
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
new Function('exports', compile(await readFile(new URL('../src/components/kitchen/KitchenDates.ts', import.meta.url), 'utf8')))(dates);
const today = '2026-11-06';
let hooks, cursor, drafts, effects, calls;
const state = initial => {
  const index = cursor++;
  if (!(index in hooks)) hooks[index] = initial;
  return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
};
const jsx = (type, props) => ({ type, props });
const modules = {
  react: { useState: state, useRef: initial => state({ current: initial })[0], useId: () => 'test', useEffect: effect => effects.push(effect) },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'react-native': { View: 'View', Pressable: 'Pressable' },
  '@/src/components/AppText': { Text: 'Text' },
  '@/src/components/ds': { Alert: 'Alert' },
  '@/src/api/kitchenProjects': { KITCHEN_STAGES: ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'], STAGE_LABELS: { installation: 'Installation' } },
  './shared': { Choice: 'Choice', displayDate: value => value || '', KitchenPanel: 'KitchenPanel', KitchenDetails: 'KitchenDetails', rupees: value => value, historicalCount: () => '' },
  './KitchenFilters': { KitchenSelect: 'KitchenSelect', KitchenDateField: 'KitchenDateField' },
  './KitchenPdfFiles': { KitchenPdfFiles: 'KitchenPdfFiles' },
  './KitchenMoney': { formatKitchenAmount: value => value, editKitchenAmount: (_, value) => ({ value, caret: 0 }) },
  './KitchenDates': { ...dates, kitchenToday: () => today },
  './KitchenVersions': { kitchenOrderContext: project => ({ order: project.orders?.at(-1), quotation: project.quotation_versions[0], design: project.design_versions[0] }), kitchenProductionStarted: project => project.production?.status !== 'Not Started' && Boolean(project.production), kitchenOrderQuotations: project => project.quotation_versions, kitchenHasFinalDesign: () => true, kitchenHasFinalQuotation: () => true },
  './DesignStage': { DesignStage: 'DesignStage' }, './QuotationStage': { QuotationStage: 'QuotationStage' },
  './KitchenProjectState': { useKitchenProject: () => ({ submission: { busy: false, setError() {} } }), useKitchenDraft: (key, initial) => {
    if (!drafts.has(key)) drafts.set(key, initial);
    return [drafts.get(key), next => drafts.set(key, typeof next === 'function' ? next(drafts.get(key)) : next)];
  } },
  '@/src/theme/tokens': { radius: {}, spacing: {} },
  './KitchenPrimitives': { KitchenButton: 'Button', KitchenTextField: 'TextField', KitchenFieldRow: 'KitchenFieldRow', kitchenColors: {}, kitchenType: {} },
};
const exports = {};
new Function('require', 'exports', compile(await readFile(new URL('../src/components/kitchen/CommercialStages.tsx', import.meta.url), 'utf8')))(name => {
  assert.ok(modules[name], name); return modules[name];
}, exports);
const project = (overrides = {}) => ({ stage: 'order', workflow_cycle: 1, permissions: { can_approve_exceptions: true }, final_design_version_id: 'design', design_versions: [{ id: 'design', number: 1 }], quotation_versions: [{ id: 'quote', number: 1, design_version_id: 'design', amount: '1000', shared_date: today, response: 'Approved' }], production: { status: 'Not Started' }, orders: [], ...overrides });
function mount(record, stage = 'order') {
  hooks = []; drafts = new Map(); calls = [];
  const props = { project: record, stage, disabled: false, command: async (command, payload) => { calls.push({ command, payload }); return true; } };
  const flatten = node => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (node.type?.name === 'WorkForm') return flatten(node.type(node.props));
    return [node, ...flatten(node.props?.children), ...flatten(node.props?.action)];
  };
  return {
    props,
    render() { cursor = 0; effects = []; const form = exports.CommercialStages(props); const tree = flatten(form.type(form.props)); effects.forEach(effect => effect()); return id => tree.find(node => node.props?.testID === id)?.props; },
  };
}

const history = mount(project());
let field = history.render();
field('kitchen-order-date').onChange('2024-01-05');
drafts.set('commercial.cycle.1.order.finalAmount.quote', '1000');
field = history.render();
assert.equal(field('kitchen-order-date').min, undefined, 'A new quotation shared today cannot block a historical customer order');
assert.equal(field('kitchen-order-confirm').disabled, false);
assert.equal(field('kitchen-production-start').value, '2024-01-05', 'The production default immediately follows an edited, unconfirmed order date');
assert.equal(drafts.get('commercial.cycle.1.production').start_date, undefined, 'Displaying the default does not record a production date');
await field('kitchen-order-confirm').onPress();
assert.equal(calls.at(-1).payload.order_date, '2024-01-05');

for (const stage of ['order', 'production']) {
  const view = mount(project({ stage, orders: [{ id: 'order', order_date: '2024-01-05', quotation_version_id: 'quote' }] }), stage);
  field = view.render();
  assert.equal(field('kitchen-production-start').value, '2024-01-05', `${stage}: the draft follows the historical customer order date`);
  assert.equal(field('kitchen-production-status').value, 'Not Started', 'Date defaults must never start work');
  assert.notEqual(field('kitchen-production-start').min, today, 'Historical production dates remain selectable');
  field('kitchen-production-status').onChange('In Production');
  field = view.render();
  await field('kitchen-production-save').onPress();
  field = view.render();
  assert.ok(field('kitchen-production-confirm-start'));
  await field('kitchen-production-confirm-start').onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).payload.start_date, '2024-01-05');
  assert.equal(calls.at(-1).payload.completion_date, '2024-03-05');

  field('kitchen-production-start').onChange('2024-02-10');
  view.props.project = { ...view.props.project, orders: [{ ...view.props.project.orders[0], order_date: '2024-01-20' }] };
  view.render();
  assert.equal(view.render()('kitchen-production-start').value, '2024-02-10', 'An explicit draft date survives an order-date change');
}
const saved = mount(project({ orders: [{ id: 'order', order_date: '2024-01-05' }], production: { status: 'In Production', start_date: '2024-02-01' } }));
assert.equal(saved.render()('kitchen-production-start').value, '2024-02-01', 'Saved historical production dates retain their value');
console.log('Kitchen historical orders and production dates passed: dates before quotation sharing, automatic draft/payload defaults, manual status, past dates and preserved edits/history');
