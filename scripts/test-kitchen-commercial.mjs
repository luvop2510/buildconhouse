import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Render the actual form with controlled drafts; exercise its available actions.
const require = createRequire(import.meta.url);
const React = require('react');
let drafts = {};
const host = type => props => React.createElement(type, props, props.children);
const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
const labels = Object.fromEntries(stages.map(stage => [stage, stage[0].toUpperCase() + stage.slice(1)]));
const mocks = {
  react: { ...React, useRef: value => ({ current: value }), useEffect: () => {}, useId: () => 'disclosure' },
  'expo-router': { useRouter: () => ({ push: path => calls.push(['navigate', path]) }) },
  'react-native': { View: host('view'), Pressable: host('button'), Linking: { openURL: () => {} } },
  '@/src/components/AppText': { Text: host('text') },
  '@/src/components/ds': { Alert: ({ title, description, action }) => React.createElement('alert', {}, title, description, action) },
  '@/src/api/kitchenProjects': { KITCHEN_STAGES: stages, STAGE_LABELS: labels },
  './shared': { Choice: host('choice'), KitchenPanel: host('panel'), displayDate: value => value || 'Not recorded', historicalCount: value => value || 0, rupees: value => value || '0.00' },
  './KitchenFilters': { KitchenDateField: host('date') },
  './KitchenDates': { kitchenToday: () => '2026-10-26' },
  './KitchenDocuments': { DocumentChoice: host('document') },
  './KitchenProjectState': { kitchenProjectPath: (id, suffix) => `/kitchen/${id}${suffix}`, useKitchenDraft: (key, initial) => [drafts[key] ?? initial, () => {}], useKitchenProject: () => ({ resetDraftValue: () => {}, returnTo: '/kitchen/stages/lead' }) },
  '@/src/theme/tokens': { radius: {}, spacing: {} },
  './KitchenPrimitives': { KitchenButton: host('button'), KitchenTextField: host('input'), KitchenFieldRow: host('row'), kitchenColors: {}, kitchenType: {} },
};
const source = await readFile(new URL('../src/components/kitchen/CommercialStages.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const exports = {};
new Function('require', 'exports', compiled)(name => mocks[name] || require(name), exports);
function flatten(node) {
  if (node == null || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (typeof node !== 'object') return [String(node)];
  if (typeof node.type === 'function') return flatten(node.type(node.props));
  return [node, ...flatten(node.props.children)];
}
const calls = [];
const design = { id: 'design', number: 1, workflow_cycle: 1, response: 'Approved', handoff_date: '2026-10-20' };
const quotation = { id: 'quotation', number: 1, design_version_id: 'design', response: 'Approved', amount: '1000.00', shared_date: '2026-10-21' };
const order = { id: 'order', quotation_version_id: 'quotation', confirmed: true, status: 'Confirmed', order_date: '2026-10-22', original_amount: '1000.00', final_amount: '1000.00', advance: { received: false } };
const base = { id: 'project', workflow_cycle: 1, visit: {}, design_versions: [design], quotation_versions: [], orders: [], permissions: { can_approve_exceptions: true }, attachments: [{ id: 'file', filename: 'quotation.pdf' }] };
function render(stage, fields = {}, values = {}, command = async (...args) => { calls.push(args); return true; }) {
  drafts = Object.fromEntries(Object.entries(values).map(([key, value]) => [`commercial.cycle.1.${key}`, value]));
  const nodes = flatten(exports.CommercialStages({ project: { ...base, stage, ...fields }, stage, disabled: false, command }));
  return { nodes, text: nodes.filter(node => typeof node === 'string').join(' '), control: id => nodes.find(node => node.props?.testID === id) };
}
let view = render('quotation', { design_versions: [] });
assert.match(view.text, /Record a design presentation in Design first/);
assert.equal(view.control('kitchen-quotation-receive').props.disabled, true);
await view.control('kitchen-complete-design').props.onPress();
assert.deepEqual(calls.pop(), ['move_stage', { target_stage: 'design' }]);
await view.control('kitchen-quotation-upload').props.onPress();
assert.deepEqual(calls.pop(), ['navigate', '/kitchen/project/documents']);
view = render('quotation', {}, { 'quotation.file': 'file', 'quotation.amount': '1200.25' });
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false);
await view.control('kitchen-quotation-receive').props.onPress();
assert.equal(calls.pop()[1].attachment_id, 'file');
for (const amount of ['', '-1', '1.111', 'NaN', '1000000000000.01']) {
  view = render('quotation', {}, { 'quotation.file': 'file', 'quotation.amount': amount });
  assert.equal(view.control('kitchen-quotation-receive').props.disabled, true, amount);
}
view = render('quotation', {}, { 'quotation.file': 'file', 'quotation.amount': '0.00' });
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false, 'Zero quotation amounts remain compatible with the API');
view = render('order', { quotation_versions: [quotation] });
assert.match(view.text, /Pending confirmation/);
assert.equal(view.control('kitchen-order-confirm').props.disabled, false, 'A pending order can be confirmed against its approved quotation');
await view.control('kitchen-order-confirm').props.onPress();
assert.equal(calls.pop()[0], 'order_confirm');
view = render('order', { quotation_versions: [{ ...quotation, response: 'Pending' }] });
assert.match(view.text, /Record the customer’s quotation approval/);
assert.equal(view.control('kitchen-order-confirm').props.disabled, true);
await view.control('kitchen-complete-quotation').props.onPress();
assert.deepEqual(calls.pop(), ['move_stage', { target_stage: 'quotation' }]);
view = render('order', { quotation_versions: [quotation], design_revision_pending: true });
assert.equal(view.control('kitchen-order-confirm').props.disabled, true, 'An approved old quotation cannot confirm a pending design revision');
assert.match(view.text, /current design needs approval/);
assert.ok(view.control('kitchen-complete-quotation'), 'Recovery returns through the adjacent Quotation stage');
view = render('order', { quotation_versions: [quotation], orders: [order] }, { 'order.advanceReceived': 'Yes', 'order.advanceAmount': '100.00' });
assert.equal(view.control('kitchen-advance-save').props.disabled, false);
await view.control('kitchen-advance-save').props.onPress();
assert.deepEqual(calls.pop(), ['order_advance', { received: true, amount: '100.00', date: '2026-10-26' }]);
view = render('order', { quotation_versions: [quotation], orders: [order] }, { 'order.advanceReceived': 'Yes', 'order.advanceAmount': '0.00' });
assert.equal(view.control('kitchen-advance-save').props.disabled, true, 'Received advances require a positive amount');
view = render('order', { quotation_versions: [quotation], orders: [order] }, { 'order.advanceReceived': 'No' });
assert.equal(view.control('kitchen-advance-save').props.disabled, false);
assert.equal(view.control('kitchen-advance-amount'), undefined);
await view.control('kitchen-advance-save').props.onPress();
assert.deepEqual(calls.pop(), ['order_advance', { received: false, amount: '0.00', date: null }]);
view = render('order', { quotation_versions: [quotation], orders: [order], permissions: {} }, { 'order.finalAmount.quotation': '1500.00', 'order.amountApproved': 'Yes' });
assert.equal(view.control('kitchen-order-confirm'), undefined, 'An existing order cannot be overwritten');
view = render('order', { quotation_versions: [quotation], permissions: {} }, { 'order.finalAmount.quotation': '1500.00', 'order.amountApproved': 'Yes' });
assert.equal(view.control('kitchen-order-confirm').props.disabled, true, 'Only an owner can confirm changed commercial terms');
view = render('installation', {}, { 'site.newVisit.expanded': true });
assert.match(view.text, /Choose whether this visit actually took place/);
assert.equal(view.control('kitchen-site-save').props.disabled, true);
view = render('installation', {}, { 'site.newVisit.expanded': true, 'site.actual': 'Yes — actual visit' });
assert.equal(view.control('kitchen-site-save').props.disabled, false);
view.control('kitchen-site-save').props.onPress();
assert.deepEqual(calls.pop(), ['site_visit', { date: '2026-10-26', actual: true, notes: null }]);
for (const stage of ['production', 'installation']) {
  const work = { status: 'Completed', start_date: '2026-10-23', completion_date: '2026-10-26', notes: 'Preserve work' };
  const commands = [];
  let finishSave;
  view = render(stage, {}, { [stage]: work }, async (...args) => {
    commands.push(args);
    return commands.length === 1 ? new Promise(resolve => { finishSave = resolve; }) : true;
  });
  const next = view.control(`kitchen-${stage}-save-next`).props.onPress;
  const first = next();
  assert.equal(await next(), false, 'Repeated taps cannot start another save/move chain');
  assert.equal(commands.length, 1);
  finishSave(true);
  assert.equal(await first, true);
  assert.deepEqual(commands, [[`${stage}_update`, work], ['move_stage', { target_stage: stage === 'production' ? 'installation' : 'completed' }]]);
  commands.length = 0;
  view = render(stage, {}, { [stage]: work }, async (...args) => { commands.push(args); return false; });
  assert.equal(await view.control(`kitchen-${stage}-save-next`).props.onPress(), false);
  assert.equal(commands.length, 1, 'Failed work saves never move stages');
  commands.length = 0;
  view = render(stage, {}, { [stage]: work }, async (...args) => { commands.push(args); return commands.length === 1; });
  assert.equal(await view.control(`kitchen-${stage}-save-next`).props.onPress(), false);
  assert.deepEqual(commands[0], [`${stage}_update`, work], 'A failed stage move does not undo the successful work save');
}
console.log('Kitchen commercial forms: prerequisite recovery, pending-order confirmation, payment validation and site visit actions passed');

// The real provider must use its saved ref between awaits, before a rerender.
const providerSource = await readFile(new URL('../src/components/kitchen/KitchenProjectState.tsx', import.meta.url), 'utf8');
async function checkProvider(source) {
  const hooks = [], effects = [], requests = [], routes = [];
  let index = 0, dirty = false, state;
  let record = { ...base, version: 7, stage: 'installation', installation: { status: 'In Progress' } };
  const same = (first, second) => first && second && first.length === second.length && first.every((value, position) => Object.is(value, second[position]));
  const hooksReact = {
    createContext: () => ({ Provider: 'provider' }),
    useState(initial) {
      const slot = index++;
      hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, next => { hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next; dirty = true; }];
    },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(callback, dependencies) {
      const slot = index++;
      if (!same(hooks[slot]?.dependencies, dependencies)) hooks[slot] = { value: callback, dependencies };
      return hooks[slot].value;
    },
    useEffect(callback, dependencies) {
      const slot = index++;
      if (!same(hooks[slot]?.dependencies, dependencies)) { hooks[slot] = { dependencies }; effects.push(callback); }
    },
  };
  const modules = {
    react: hooksReact, 'react/jsx-runtime': { jsx: (_type, props) => ({ props }) },
    'expo-router': { useRouter: () => ({ replace: route => routes.push(route) }) },
    '@/src/api/kitchenProjects': { KITCHEN_STAGES: stages, kitchenProjectsApi: {
      get: async () => record, configuration: async () => ({}),
      command: async (id, version, _key, command, payload) => {
        requests.push({ id, version, command, payload });
        assert.equal(version, record.version, 'Each write uses the latest accepted version');
        if (command === 'installation_update') record = { ...record, version: version + 1, stage: 'completed', installation: payload };
        else {
          assert.notEqual(payload.target_stage, record.stage, 'The real backend rejects a redundant same-stage move');
          record = { ...record, version: version + 1, stage: payload.target_stage };
        }
        return record;
      },
    } },
    './shared': { errorText: String, useKitchenSubmission: () => ({ submit: async (_fingerprint, work, accepted) => { const value = await work('provider-fixture'); accepted(value); return true; } }) },
    './KitchenDates': { kitchenToday: () => '2026-10-26' },
    './KitchenExitGuard': { useKitchenExitGuard: () => {} },
  };
  const providerExports = {};
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'exports', output)(name => { assert.ok(modules[name], name); return modules[name]; }, providerExports);
  function renderProvider() {
    index = 0; dirty = false;
    state = providerExports.KitchenProjectProvider({ id: 'project', children: null }).props.value;
    while (effects.length) effects.shift()();
  }
  renderProvider();
  for (let turn = 0; turn < 12; turn++) { await Promise.resolve(); if (dirty) renderProvider(); }
  assert.equal(state.loading, false);
  const captured = state.command;
  assert.equal(await captured('installation_update', { status: 'Completed', start_date: '2026-10-25', completion_date: '2026-10-26' }), true);
  // Intentionally do not render: the next await in Save and Next has this closure.
  assert.equal(await captured('move_stage', { target_stage: 'completed' }), true);
  assert.equal(requests.length, 1, 'Automatic legacy completion needs no second HTTP write');
  assert.equal(await captured('move_stage', { target_stage: 'installation' }), true);
  assert.deepEqual(requests.map(({ version, command }) => [version, command]), [[7, 'installation_update'], [8, 'move_stage']]);
  assert.equal(routes.length, 2, 'Real stage changes each update the current route');
}
await checkProvider(providerSource);
await assert.rejects(checkProvider(providerSource.replace('if (name === "move_stage" && current.stage === payload.target_stage) return Promise.resolve(true);', '')), /redundant same-stage move/, 'Negative control reproduces the rejected legacy second move without the fix');
console.log('Kitchen actual provider: legacy completion skips duplicate move; captured callbacks use the latest saved version (negative control fails as expected)');
