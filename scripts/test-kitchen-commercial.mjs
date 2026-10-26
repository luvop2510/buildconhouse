import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Render the actual form with controlled drafts; exercise its available actions.
const require = createRequire(import.meta.url);
const React = require('react');
let drafts = {};
let feedback = null;
let componentState = [];
let hookIndex = 0;
const host = type => function TestHost(props) { return React.createElement(type, props, props.children); };
const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
const labels = Object.fromEntries(stages.map(stage => [stage, stage[0].toUpperCase() + stage.slice(1)]));
const mocks = {
  react: { ...React, useState: initial => { const index = hookIndex++; if (!(index in componentState)) componentState[index] = initial; return [componentState[index], value => { componentState[index] = typeof value === 'function' ? value(componentState[index]) : value; }]; }, useRef: value => ({ current: value }), useEffect: () => {}, useId: () => 'disclosure' },
  'expo-router': { useRouter: () => ({ push: path => calls.push(['navigate', path]) }) },
  'react-native': { View: host('view'), Pressable: host('button'), Linking: { openURL: () => {} } },
  '@/src/components/AppText': { Text: host('text') },
  '@/src/components/ds': { Alert: ({ title, description, action }) => React.createElement('alert', {}, title, description, action) },
  '@/src/api/kitchenProjects': { KITCHEN_STAGES: stages, STAGE_LABELS: labels },
  './shared': { Choice: host('choice'), KitchenPanel: host('panel'), KitchenDetails: ({ items, testID }) => React.createElement('details', { testID }, items.map(item => `${item.label}: ${item.value}`).join(' ')), displayDate: value => value || 'Not recorded', historicalCount: value => value || 0, rupees: value => value || '0.00' },
  './KitchenFilters': { KitchenDateField: host('date'), KitchenSelect: host('select') },
  './KitchenDates': { kitchenToday: () => '2026-10-26' },
  './KitchenDocuments': { DocumentChoice: host('document') },
  './KitchenProjectState': { kitchenProjectPath: (id, suffix) => `/kitchen/${id}${suffix}`, useKitchenDraft: (key, initial) => [drafts[key] ?? initial, value => { drafts[key] = typeof value === 'function' ? value(drafts[key] ?? initial) : value; }], useKitchenProject: () => ({ resetDraftValue: () => {}, returnTo: '/kitchen/stages/lead', submission: { setError: update => { feedback = typeof update === 'function' ? update(feedback) : update; } } }) },
  '@/src/theme/tokens': { radius: {}, spacing: {} },
  './KitchenPrimitives': { KitchenButton: host('button'), KitchenTextField: host('input'), KitchenFieldRow: host('row'), kitchenColors: {}, kitchenType: {} },
};
const versionExports = {};
const versionSource = await readFile(new URL('../src/components/kitchen/KitchenVersions.ts', import.meta.url), 'utf8');
new Function('exports', ts.transpileModule(versionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(versionExports);
mocks['./KitchenVersions'] = versionExports;
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
const design = { id: 'design', number: 1, workflow_cycle: 1, response: 'Approved', approval_date: '2026-10-19', shared_date: '2026-10-18', handoff_date: '2026-10-20', requirements: 'Version one requirements', notes: 'Version one internal notes' };
const quotation = { id: 'quotation', number: 1, design_version_id: 'design', response: 'Approved', amount: '1000.00', shared_date: '2026-10-21' };
const order = { id: 'order', quotation_version_id: 'quotation', confirmed: true, status: 'Confirmed', order_date: '2026-10-22', original_amount: '1000.00', final_amount: '1000.00', advance: { received: false } };
const base = { id: 'project', workflow_cycle: 1, visit: {}, design_versions: [design], quotation_versions: [], orders: [], permissions: { can_approve_exceptions: true }, attachments: [{ id: 'file', filename: 'quotation.pdf' }] };
function render(stage, fields = {}, values = {}, command = async (...args) => { calls.push(args); return true; }) {
  drafts = Object.fromEntries(Object.entries(values).map(([key, value]) => [`commercial.cycle.1.${key}`, value]));
  componentState = [];
  const props = { project: { ...base, stage, ...fields }, stage, disabled: false, command };
  function refresh() {
    hookIndex = 0;
    const nodes = flatten(exports.CommercialStages(props));
    return { nodes, text: nodes.filter(node => typeof node === 'string').join(' ').replace(/\s+/g, ' '), control: id => nodes.find(node => node.props?.testID === id), refresh };
  }
  return refresh();
}
let view = render('quotation', { design_versions: [] });
assert.match(view.text, /Record a design presentation in Design first/);
assert.equal(view.control('kitchen-quotation-receive').props.disabled, true);
await view.control('kitchen-complete-design').props.onPress();
assert.deepEqual(calls.pop(), ['move_stage', { target_stage: 'design' }]);
assert.equal(view.control('kitchen-quotation-upload'), undefined);
assert.equal(view.nodes.some(node => node.type === 'document'), false, 'Quotation creation no longer requests a document');
view = render('quotation', {}, { 'quotation.file': 'file', 'quotation.amount': '1200.25' });
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false);
await view.control('kitchen-quotation-receive').props.onPress();
assert.deepEqual(calls.pop(), ['quotation_receive', { design_version_id: 'design', amount: '1200.25', received_date: '2026-10-26', notes: null }]);
for (const amount of ['-1', '1.111', 'NaN', '1000000000000.01']) {
  view = render('quotation', {}, { 'quotation.file': 'file', 'quotation.amount': amount });
  assert.equal(view.control('kitchen-quotation-receive').props.disabled, true, amount);
}
view = render('quotation', {}, { 'quotation.file': 'file', 'quotation.amount': '0.00' });
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false, 'Zero quotation amounts remain compatible with the API');
view = render('order', { quotation_versions: [quotation] }, { 'order.confirmed': 'Yes' });
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
assert.match(view.text, /selected design needs approval/);
assert.ok(view.control('kitchen-complete-quotation'), 'Recovery returns through the adjacent Quotation stage');
for (const amount of ['', '   ']) {
  view = render('quotation', {}, { 'quotation.amount': amount });
  assert.equal(view.control('kitchen-quotation-receive').props.disabled, false, 'A quotation saves without an amount or document');
  await view.control('kitchen-quotation-receive').props.onPress();
  assert.equal(calls.pop()[1].amount, null, 'Blank amount is missing rather than zero');
}
for (const value of ['Not recorded', 'Yes', 'No']) {
  view = render('order', { quotation_versions: [quotation], customer_order_confirmation: value });
  assert.match(view.text, new RegExp(`Customer order confirmation: ${value}`));
  assert.deepEqual(view.control('kitchen-order-confirmed').props.values, ['Not recorded', 'Yes', 'No']);
  await view.control('kitchen-order-confirmation-save').props.onPress();
  assert.deepEqual(calls.pop(), ['order_confirmation', { value }]);
  assert.equal(view.control('kitchen-order-confirm').props.disabled, value !== 'Yes');
}
view = render('order', { quotation_versions: [quotation], orders: [order] }, { 'order.statusEdit.expanded': true, 'order.status': 'On Hold', 'order.statusReason': 'Awaiting internal review' });
assert.deepEqual(view.control('kitchen-order-status').props.values, ['Confirmed', 'On Hold', 'Cancelled']);
await view.control('kitchen-order-status-save').props.onPress();
assert.deepEqual(calls.pop(), ['order_status', { status: 'On Hold', reason: 'Awaiting internal review' }]);
assert.equal(view.nodes.some(node => node.type === 'document'), false, 'Order confirmation never requests a new document');
const design2 = { ...design, id: 'design-two', number: 2, requirements: 'Version two requirements', notes: 'Version two internal notes' };
const quote2 = { ...quotation, id: 'quotation-two', number: 7, design_version_id: design2.id, notes: 'Revision seven notes' };
view = render('design', { design_versions: [{ ...design, approval_date: '2026-10-20' }] }, { 'design.design.edit.expanded': true });
view.control('kitchen-design-edit-response').props.onChange('Pending');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-handoff'), undefined, 'Changing approval clears the current handoff');
assert.equal(view.control('kitchen-design-edit-save').props.disabled, false, 'A pending approval does not trap the form');
await view.control('kitchen-design-edit-save').props.onPress();
assert.deepEqual([calls.at(-1)[1].approval_date, calls.at(-1)[1].handoff_date], [null, null]);
calls.length = 0;
view = render('design', { design_versions: [design, design2], quotation_versions: [quotation, quote2] });
assert.match(view.text, /Version two requirements/);
view.control('kitchen-design-version').props.onChange(design.id);
view = view.refresh();
assert.match(view.text, /Version one requirements/);
assert.doesNotMatch(view.text, /Version two requirements/);
assert.match(view.text, /Related quotation revisions: r1/);
assert.equal(calls.length, 0, 'Viewing a design does not write');
view = render('design', { design_versions: [design, design2], quotation_versions: [quotation, quote2] }, { 'design.design.edit.expanded': true });
view.control('kitchen-design-version').props.onChange(design.id);
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-notes').props.value, design.notes);
view.control('kitchen-design-edit-notes').props.onChangeText('Correct version one internal details');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-save').props.disabled, false);
await view.control('kitchen-design-edit-save').props.onPress();
assert.equal(calls.pop()[1].version_id, design.id, 'Edits send the selected design version ID');
view.control('kitchen-design-edit-handoff').props.onChange('2026-10-18');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-save').props.disabled, true, 'Handoff before approval cannot be saved');
view.control('kitchen-design-edit-handoff').props.onChange('2026-10-21');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-save').props.disabled, false, 'A handoff after approval may occur on a later day');
view = render('quotation', { design_versions: [design, design2], quotation_versions: [quotation, quote2] }, { 'quotation.newVersion.expanded': true });
assert.match(view.text, /Quotation r7 · Design v2/);
view.control('kitchen-quotation-design-version').props.onChange(design.id);
view = view.refresh();
assert.match(view.text, /Quotation r1 · Design v1/);
await view.control('kitchen-quotation-receive').props.onPress();
assert.equal(calls.pop()[1].design_version_id, design.id, 'A revised quote retains the explicitly selected design ID');
view = render('order', { design_versions: [design, design2], quotation_versions: [quotation, quote2] }, { 'order.confirmed': 'Yes' });
view.control('kitchen-order-quotation-revision').props.onChange(quotation.id);
view = view.refresh();
await view.control('kitchen-order-confirm').props.onPress();
assert.equal(calls.pop()[1].quotation_version_id, quotation.id, 'An older valid quotation can be explicitly selected for the order');
view = render('order', { design_versions: [design, design2], quotation_versions: [quotation, quote2], orders: [order] });
view.control('kitchen-order-quotation-revision').props.onChange(quote2.id);
view = view.refresh();
assert.match(view.text, /Order quotation: Quotation r1 · Design v1/);
assert.match(view.text, /Selected quotation: Quotation r7 · Design v2/);
assert.equal(calls.length, 0, 'Historical quote viewing never changes the saved order');
for (const stage of ['production', 'installation']) {
  view = render(stage, { design_versions: [design, design2], quotation_versions: [quotation, quote2], orders: [order] });
  assert.match(view.text, /Quotation r1 · Design v1/, 'Downstream context follows the saved order IDs, not the latest design');
}
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
  feedback = 'Request timed out. Please try again.';
  view = render(stage, {}, { [stage]: work }, async (...args) => { commands.push(args); return commands.length === 1; });
  assert.equal(await view.control(`kitchen-${stage}-save-next`).props.onPress(), false);
  assert.deepEqual(commands[0], [`${stage}_update`, work], 'A failed stage move does not undo the successful work save');
  assert.match(feedback, /details were saved/);
  assert.match(feedback, /use Next stage to retry/);
  assert.match(feedback, /Request timed out/, 'Preserve the underlying failure for review');
}
console.log('Kitchen commercial forms: optional quotation fields, selected version relationships, confirmation states, handoff dates, payment and work actions passed');

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
