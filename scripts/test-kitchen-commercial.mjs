import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Render the actual form with controlled drafts; exercise its available actions.
const require = createRequire(import.meta.url);
const React = require('react');
let drafts = {};
let feedback = null;
let autosaveOptions;
let autosaveStatus = 'saved';
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
  './KitchenAutosave': { useKitchenAutosave: options => { autosaveOptions = options; return { status: autosaveStatus, retry: () => {} }; } },
  './KitchenDocuments': { DocumentChoice: host('document') },
  './KitchenProjectState': { kitchenProjectPath: (id, suffix) => `/kitchen/${id}${suffix}`, useKitchenDraft: (key, initial) => [drafts[key] ?? initial, value => { drafts[key] = typeof value === 'function' ? value(drafts[key] ?? initial) : value; }], useKitchenProject: () => ({ resetDraftValue: () => {}, returnTo: '/kitchen/stages/lead', submission: { setError: update => { feedback = typeof update === 'function' ? update(feedback) : update; } } }) },
  '@/src/theme/tokens': { radius: {}, spacing: {} },
  './KitchenPrimitives': { KitchenButton: host('button'), KitchenTextField: host('input'), KitchenFieldRow: host('row'), kitchenColors: {}, kitchenType: {} },
};
const versionExports = {};
const versionSource = await readFile(new URL('../src/components/kitchen/KitchenVersions.ts', import.meta.url), 'utf8');
new Function('exports', ts.transpileModule(versionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(versionExports);
mocks['./KitchenVersions'] = versionExports;
for (const component of ['DesignStage', 'QuotationStage']) {
  const content = await readFile(new URL(`../src/components/kitchen/${component}.tsx`, import.meta.url), 'utf8');
  const output = {};
  new Function('require', 'exports', ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText)(name => mocks[name] || require(name), output);
  mocks[`./${component}`] = output;
}
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
function render(stage, fields = {}, values = {}, command = async (...args) => { calls.push(args); return true; }, mode = 'task') {
  drafts = Object.fromEntries(Object.entries(values).map(([key, value]) => [`commercial.cycle.1.${key}`, value]));
  componentState = [];
  const props = { project: { ...base, stage, ...fields }, stage, disabled: false, command, mode };
  function refresh() {
    hookIndex = 0;
    const nodes = flatten(exports.CommercialStages(props));
    return { nodes, text: nodes.filter(node => typeof node === 'string').join(' ').replace(/\s+/g, ' '), control: id => nodes.find(node => node.props?.testID === id), refresh };
  }
  return refresh();
}
let view = render('quotation', { design_versions: [] });
assert.equal(view.control('kitchen-quotation-receive').props.disabled, true);
await view.control('kitchen-complete-design').props.onPress();
assert.deepEqual(calls.pop(), ['move_stage', { target_stage: 'design' }]);
assert.equal(view.nodes.some(node => node.type === 'document'), false);
for (const amount of ['', '1200.25', '0.00', '-1', '1.111', 'NaN', '1000000000000.01']) {
  view = render('quotation');
  view.control('kitchen-quotation-amount').props.onChangeText(amount);
  view = view.refresh();
  assert.equal(view.control('kitchen-quotation-receive').props.disabled, ['-1', '1.111', 'NaN', '1000000000000.01'].includes(amount));
  if (!view.control('kitchen-quotation-receive').props.disabled) {
    await view.control('kitchen-quotation-receive').props.onPress();
    const [command, body] = calls.pop();
    assert.equal(command, 'quotation_receive');
    assert.equal(body.amount, amount || null);
    assert.equal(body.received_status, 'Not recorded');
    assert.equal(body.sent_status, 'Not recorded');
    assert.equal(body.received_date, null);
    assert.equal(body.shared_date, null);
  }
}
view = render('order', { quotation_versions: [quotation] }, { 'order.confirmed': 'Yes', 'order.date': '2026-10-26', 'order.finalAmount.quotation': '1000.00', 'order.finalAmount.quotation-two': '1000.00' });
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
for (const value of ['Not recorded', 'Yes', 'No']) {
  view = render('order', { quotation_versions: [quotation], customer_order_confirmation: value }, { 'order.date': '2026-10-26', 'order.finalAmount.quotation': '1000.00' });
  assert.equal(view.control('kitchen-order-confirmed').props.value, value);
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
view = render('design', { design_versions: [{ ...design, approval_date: '2026-10-20' }] });
assert.equal(view.control('kitchen-design-edit-date'), undefined, 'Presentation date is removed');
view.control('kitchen-design-edit-response').props.onChange('Pending');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-handoff').props.value, design.handoff_date, 'Changing response does not silently rewrite entered dates');
assert.equal(view.control('kitchen-design-edit-save').props.disabled, true);
assert.equal(view.control('kitchen-design-edit-approval-date'), undefined, 'Pending has no approval date entry');
view.control('kitchen-design-sent').props.onChange('Not recorded');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-save').props.disabled, false);
await view.control('kitchen-design-edit-save').props.onPress();
assert.equal(calls.at(-1)[1].presentation_date, undefined, 'Historical presentation date is omitted and preserved');
calls.length = 0;
view = render('design', { design_versions: [] });
assert.equal(view.control('kitchen-design-edit-shared').props.value, '2026-10-26', 'A new design date defaults to today in India');
view.control('kitchen-design-edit-shared').props.onChange('2026-10-25');
view.control('kitchen-design-edit-response').props.onChange('Approved');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-shared').props.value, '2026-10-25', 'The default date stays editable');
assert.equal(view.control('kitchen-design-edit-approval-date').props.value, '2026-10-26');
view.control('kitchen-design-sent').props.onChange('Yes');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-handoff').props.value, '2026-10-26');
await view.control('kitchen-design-present').props.onPress();
assert.deepEqual([calls.at(-1)[1].shared_date, calls.at(-1)[1].approval_date, calls.at(-1)[1].handoff_date, calls.at(-1)[1].handoff_status], ['2026-10-25','2026-10-26','2026-10-26','Yes']);
calls.length = 0;
view = render('design', { visit: { requirements: 'Different Visit requirements', budget_discussion: 'Different Visit budget' }, design_versions: [{ ...design, requirements: null, budget_discussion: null }] });
assert.equal(view.control('kitchen-design-edit-requirements').props.value, '', 'Saved versions never inherit missing data from Visit');
assert.equal(view.control('kitchen-design-edit-budget').props.value, '');
await view.control('kitchen-design-edit-save').props.onPress();
assert.equal(calls.at(-1)[1].requirements, null);
assert.equal(calls.at(-1)[1].budget_discussion, null);
calls.length = 0;
view = render('design', { design_versions: [design, design2], quotation_versions: [quotation, quote2] });
assert.equal(view.control('kitchen-design-edit-requirements').props.value, 'Version two requirements');
view.control('kitchen-design-version').props.onChange(design.id);
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-requirements').props.value, 'Version one requirements');
assert.doesNotMatch(view.text, /Version two requirements/);
assert.match(view.text, /Linked quotations: Quotation 1/);
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
view = render('quotation', { design_versions: [design, design2], quotation_versions: [quotation, quote2] });
assert.match(view.text, /Quotation 7/);
assert.equal(view.control('kitchen-quotation-design-version').props.value, design2.id);
view.control('kitchen-quotation-revision').props.onChange(quotation.id);
view = view.refresh();
assert.match(view.text, /Quotation 1/);
assert.equal(view.control('kitchen-quotation-design-version').props.value, design.id);
assert.equal(calls.length, 0, 'Viewing a saved quotation changes no association');
view.control('kitchen-quotation-new-version').props.onPress();
view = view.refresh();
assert.ok(view.control('kitchen-quotation-receive'));
assert.equal(view.control('kitchen-quotation-design-version').props.value, design.id, 'Another quotation can retain Design v1');
await view.control('kitchen-quotation-receive').props.onPress();
assert.equal(calls.pop()[1].design_version_id, design.id, 'A new quotation retains the explicitly chosen design ID');
view.control('kitchen-quotation-new-version').props.onPress();
view = view.refresh();
view.control('kitchen-quotation-design-version').props.onChange(design2.id);
view = view.refresh();
await view.control('kitchen-quotation-receive').props.onPress();
assert.equal(calls.pop()[1].design_version_id, design2.id, 'Related design is independently editable for the new quotation');
view = render('quotation', { workflow_cycle: 2, design_versions: [{ ...design, workflow_cycle: 1 }, { ...design2, workflow_cycle: 2 }], quotation_versions: [quote2] });
view.control('kitchen-quotation-design-version').props.onChange(design.id);
view = view.refresh();
assert.ok(view.control('kitchen-quotation-design-version'), 'An invalid draft design choice stays editable');
assert.equal(view.control('kitchen-quotation-edit-save').props.disabled, true);
view.control('kitchen-quotation-design-version').props.onChange(design2.id);
view = view.refresh();
assert.equal(view.control('kitchen-quotation-edit-save').props.disabled, false, 'Restore the valid saved design without discarding the draft');
view = render('quotation', { workflow_cycle: 2, design_versions: [design, { ...design2, workflow_cycle: 2 }], quotation_versions: [quotation] });
view.control('kitchen-quotation-new-version').props.onPress();
view = view.refresh();
assert.equal(view.control('kitchen-quotation-design-version').props.value, design2.id, 'A new quotation after Return to Design starts in the current work cycle');
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false, 'Historical quotation viewing cannot trap new current-cycle quotation entry');
view = render('quotation', { design_versions: [design, design2], quotation_versions: [quotation], orders: [order] }, { 'quotation.quotation.edit': { source: JSON.stringify(quotation), design_version_id: design2.id, amount: '1000.00', received_status: 'Not recorded', received_date: '', sent_status: 'Yes', shared_date: quotation.shared_date, response: 'Approved', notes: 'Unsaved basis draft' } });
assert.equal(view.control('kitchen-quotation-edit-save').props.disabled, true, 'An order binding requires review of an earlier unsaved design-association draft');
assert.ok(view.control('kitchen-quotation-edit-reload'), 'The bound design conflict offers an explicit draft replacement');
assert.match(view.text, /Related design: Design v1/, 'The order-bound display always shows the actual saved design');
view = render('order', { design_versions: [design, design2], quotation_versions: [quotation, quote2] }, { 'order.confirmed': 'Yes', 'order.date': '2026-10-26', 'order.finalAmount.quotation': '1000.00', 'order.finalAmount.quotation-two': '1000.00' });
view.control('kitchen-order-quotation-revision').props.onChange(quotation.id);
view = view.refresh();
await view.control('kitchen-order-confirm').props.onPress();
assert.equal(calls.pop()[1].quotation_version_id, quotation.id, 'An older valid quotation can be explicitly selected for the order');
view = render('order', { design_versions: [design, design2], quotation_versions: [quotation, quote2], orders: [order] }, { 'order.details.expanded': true });
assert.equal(view.control('kitchen-disclose-order-details'), undefined, 'Order no longer displays Original terms and documents');
assert.equal(view.control('kitchen-order-quotation-revision'), undefined, 'Recorded order has no redundant original-quotation selector');
assert.match(view.text, /Order quotation: Quotation 1 · Design v1/);
assert.equal(calls.length, 0, 'Removing display details does not change the saved order');
for (const stage of ['production', 'installation']) {
  view = render(stage, { design_versions: [design, design2], quotation_versions: [quotation, quote2], orders: [order] });
  assert.match(view.text, /Quotation 1 · Design v1/, 'Downstream context follows the saved order IDs, not the latest design');
  assert.equal(view.control(`kitchen-${stage}-details`), undefined, 'Active work forms are the single source for status, dates and notes');
}
view = render('order', { quotation_versions: [quotation], orders: [order] }, { 'order.advanceEdit.expanded': true, 'order.advanceReceived': 'Yes', 'order.advanceAmount': '100.00', 'order.advanceDate': '2026-10-26' }, undefined, 'advance');
assert.equal(view.control('kitchen-advance-save').props.disabled, false);
await view.control('kitchen-advance-save').props.onPress();
assert.deepEqual(calls.pop(), ['order_advance', { status: 'Yes', received: true, amount: '100.00', date: '2026-10-26' }]);
view = render('order', { quotation_versions: [quotation], orders: [order] }, { 'order.advanceEdit.expanded': true, 'order.advanceReceived': 'Yes', 'order.advanceAmount': '0.00' }, undefined, 'advance');
assert.equal(view.control('kitchen-advance-save').props.disabled, true, 'Received advances require a positive amount');
view = render('order', { quotation_versions: [quotation], orders: [order] }, { 'order.advanceEdit.expanded': true, 'order.advanceReceived': 'No' }, undefined, 'advance');
assert.equal(view.control('kitchen-advance-save').props.disabled, false);
assert.equal(view.control('kitchen-advance-amount').props.value, '');
await view.control('kitchen-advance-save').props.onPress();
assert.deepEqual(calls.pop(), ['order_advance', { status: 'No', received: false, amount: '0.00', date: null }]);
view = render('order', { quotation_versions: [quotation], orders: [order], permissions: {} }, { 'order.finalAmount.quotation': '1500.00', 'order.amountApproved': 'Yes' });
assert.equal(view.control('kitchen-order-confirm'), undefined, 'An existing order cannot be overwritten');
view = render('order', { quotation_versions: [quotation], permissions: {} }, { 'order.finalAmount.quotation': '1500.00', 'order.amountApproved': 'Yes' });
assert.equal(view.control('kitchen-order-confirm').props.disabled, true, 'Only an owner can confirm changed commercial terms');
view = render('installation', {}, {}, undefined, 'visits');
assert.match(view.text, /Choose whether this visit actually took place/);
assert.equal(view.control('kitchen-site-save').props.disabled, true);
view = render('installation', {}, { 'site.actual': 'Yes — actual visit' }, undefined, 'visits');
assert.equal(view.control('kitchen-site-save').props.disabled, false);
view.control('kitchen-site-save').props.onPress();
assert.deepEqual(calls.pop(), ['site_visit', { date: '2026-10-26', actual: true, notes: null }]);

view = render('order', { quotation_versions: [quotation], orders: [order] });
assert.ok(view.control('kitchen-order-edit-date'), 'Routine order date stays open');
assert.ok(view.control('kitchen-order-edit-notes'), 'Routine order notes stay open');
for (const id of ['kitchen-amend-save', 'kitchen-advance-save', 'kitchen-order-status-save', 'kitchen-order-confirmation-save', 'kitchen-order-edit-save']) assert.equal(view.control(id), undefined, `${id} stays behind its explicit disclosure`);
assert.equal(view.nodes.filter(node => node.type === 'panel').length, 1, 'Order uses one form panel');
assert.equal(view.nodes.filter(node => node.type === 'panel' && node.props.title).length, 0, 'The page header names Order once');
assert.equal(view.nodes.some(node => node.type === 'panel' && ['Approved order amendment', 'Advance payment'].includes(node.props.title)), false, 'Amendment and advance retain their actions without duplicate boxes');
assert.equal(view.control('kitchen-order-details'), undefined, 'Order does not repeat its editable values in summary boxes');
assert.equal(view.text.match(/Approved final amount:/g)?.length, 1, 'The approved amount has one location');
view.control('kitchen-order-edit-notes').props.onChangeText('Internal autosaved note');
view = view.refresh();
assert.equal(calls.length, 0, 'Typing never submits a consequential command');
assert.equal(autosaveOptions.enabled, true);
await autosaveOptions.save();
assert.deepEqual(calls.pop(), ['order_update', { order_date: order.order_date, notes: 'Internal autosaved note' }, true]);
view.control('kitchen-disclose-order-quotation').props.onPress();
view = view.refresh();
view.control('kitchen-order-edit-quotation').props.onChange('different-quotation');
view = view.refresh();
assert.equal(autosaveOptions.enabled, false, 'A changed quotation basis cannot autosave');
assert.ok(view.control('kitchen-order-edit-save'), 'A quotation change keeps explicit confirmation');
autosaveStatus = 'failed';
view = render('order', { quotation_versions: [quotation], orders: [order] });
assert.ok(view.control('kitchen-order-autosave-retry'), 'Failed ordinary writes expose retry');
autosaveStatus = 'saved';

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
        else if (command === 'move_stage') {
          assert.notEqual(payload.target_stage, record.stage, 'The real backend rejects a redundant same-stage move');
          record = { ...record, version: version + 1, stage: payload.target_stage };
        } else record = { ...record, version: version + 1 };
        return record;
      },
    } },
    './shared': { errorText: String, useKitchenSubmission: () => ({ submit: async (_fingerprint, work, accepted) => { const value = await work('provider-fixture'); accepted(value); return true; } }) },
    './KitchenDates': { kitchenToday: () => '2026-10-26' },
  './KitchenAutosave': { useKitchenAutosave: options => { autosaveOptions = options; return { status: autosaveStatus, retry: () => {} }; } },
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
  renderProvider();
  const firstDraft = 'commercial.cycle.1.quotation.new.d1.edit';
  const otherDraft = 'commercial.cycle.1.quotation.new.d2.edit';
  state.setDraftValue(firstDraft, { amount: '' }, { amount: '100' });
  state.setDraftValue(otherDraft, { amount: '' }, { amount: '200' });
  renderProvider();
  await state.command('quotation_receive', { design_version_id: 'd1' });
  renderProvider();
  assert.equal(state.drafts[firstDraft], undefined, 'A saved quotation clears its own new-version draft');
  assert.deepEqual(state.drafts[otherDraft], { amount: '200' }, 'Saving one design quotation keeps another design’s unsaved draft');
}
await checkProvider(providerSource);
await assert.rejects(checkProvider(providerSource.replace('if (name === "move_stage" && current.stage === payload.target_stage) return Promise.resolve(true);', '')), /redundant same-stage move/, 'Negative control reproduces the rejected legacy second move without the fix');
console.log('Kitchen actual provider: legacy completion skips duplicate move; captured callbacks use the latest saved version (negative control fails as expected)');

for (const stage of ['order','installation']) {
  const task=render(stage,{quotation_versions:[quotation],orders:[order]});
  for(const id of ['kitchen-disclose-advance','kitchen-disclose-amendment','kitchen-disclose-site-visit','kitchen-site-save','kitchen-advance-save','kitchen-amend-save'])assert.equal(task.control(id),undefined,`${stage}: ${id} must be absent from the main task, including collapsed buttons`);
  assert.doesNotMatch(task.text,/Advance payment received|Amend approved amount|Installation site visits/);
}

for(const stage of ['production','installation']) {
  for(const status of ['Not Started',stage==='production'?'In Production':'In Progress','Completed']) {
    const commands=[];
    const task=render(stage,{}, { [stage]: {status} }, async (...args)=>{commands.push(args);return true;});
    assert.equal(task.control(`kitchen-${stage}-start`).props.value,'2026-10-26');
    assert.equal(task.control(`kitchen-${stage}-complete`).props.value,'2026-10-26');
    await task.control(`kitchen-${stage}-save`).props.onPress();
    assert.deepEqual(commands,[[`${stage}_update`,{status,start_date:status==='Not Started'?null:'2026-10-26',completion_date:status==='Completed'?'2026-10-26':null,notes:null}]],'Proposed dates never change the selected status or violate the work API');
  }
}
