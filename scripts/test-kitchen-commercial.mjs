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
  './KitchenFilters': { KitchenDateField: host('date'), KitchenSelect: host('select'), KitchenOption: host('option') },
  './KitchenDates': { kitchenToday: () => '2026-10-26' },
  './KitchenAutosave': { useKitchenAutosave: options => { autosaveOptions = options; return { status: autosaveStatus, retry: () => {} }; } },
  './KitchenDocuments': { DocumentChoice: host('document') },
  './KitchenPdfFiles': { KitchenPdfFiles: host('pdf-files'), KitchenPdfFile: host('pdf-file') },
  './KitchenProjectState': { kitchenProjectPath: (id, suffix) => `/kitchen/${id}${suffix}`, useKitchenDraft: (key, initial) => [drafts[key] ?? initial, value => { drafts[key] = typeof value === 'function' ? value(drafts[key] ?? initial) : value; }], useKitchenProject: () => ({ resetDraftValue: () => {}, documentSubmission: { busy: false }, returnTo: '/kitchen/stages/lead', submission: { setError: update => { feedback = typeof update === 'function' ? update(feedback) : update; } } }) },
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
const design = { attachment_ids: ['design-file'], final_attachment_id: 'design-file', handoff_status: 'Yes', id: 'design', number: 1, workflow_cycle: 1, response: 'Approved', approval_date: '2026-10-19', shared_date: '2026-10-18', handoff_date: '2026-10-20', requirements: 'Version one requirements', notes: 'Version one internal notes' };
const quotation = { pdf_options: [{attachment_id: 'file', kitchen_type: 'GI'}], final_attachment_id: 'file', id: 'quotation', number: 1, design_version_id: 'design', response: 'Approved', amount: '1000.00', shared_date: '2026-10-21' };
const order = { id: 'order', quotation_version_id: 'quotation', confirmed: true, status: 'Confirmed', order_date: '2026-10-22', original_amount: '1000.00', final_amount: '1000.00', advance: { received: false } };
const base = { id: 'project', workflow_cycle: 1, final_design_version_id: 'design', visit: {}, design_versions: [design], quotation_versions: [], orders: [], permissions: { can_approve_exceptions: true }, attachments: ['file', 'design-file', 'ss-file', 'mix-file'].map(id => ({id, filename: `${id}.pdf`, content_type: 'application/pdf', uploaded_at: '2026-10-19T10:00:00Z', size_bytes: 1000})) };
function render(stage, fields = {}, values = {}, command = async (...args) => { calls.push(args); return true; }, mode = 'task') {
  drafts = Object.fromEntries(Object.entries(values).map(([key, value]) => [`commercial.cycle.1.${key}`, value]));
  componentState = [];
  const props = { project: { ...base, stage, ...fields }, stage, disabled: false, command, mode };
  function refresh(projectFields, disabled) {
    if (projectFields) Object.assign(props.project, projectFields);
    if (typeof disabled === 'boolean') props.disabled = disabled;
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
function chooseQuotation(view, kitchenType = 'GI', id = 'file') {
  view.control(`kitchen-quotation-${kitchenType}-pdf`).props.onAdd(id);
  view = view.refresh();
  view.control(`kitchen-quotation-${kitchenType}-pdf`).props.onSelect(id);
  return view.refresh();
}
view = render('quotation');
for (const retired of ['kitchen-quotation-amount', 'kitchen-quotation-date', 'kitchen-quotation-received', 'kitchen-quotation-notes']) assert.equal(view.control(retired), undefined);
assert.equal(view.control('kitchen-quotation-receive').props.disabled, true, 'A PDF is required');
view.control('kitchen-quotation-GI-pdf').props.onAdd('file');
view = view.refresh();
assert.equal(view.control('kitchen-quotation-receive').props.disabled, true, 'Uploading does not silently finalize a quotation');
view = chooseQuotation(view);
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false);
view = chooseQuotation(view, 'SS', 'ss-file');
view = chooseQuotation(view, 'Mix', 'mix-file');
assert.equal(view.control('kitchen-quotation-GI-pdf').props.finalId, 'mix-file', 'All kitchen types share exactly one final PDF');
assert.match(view.text, /Final kitchen type: Mix/);
await view.control('kitchen-quotation-receive').props.onPress();
const [quotationCommand, quotationPayload] = calls.pop();
assert.equal(quotationCommand, 'quotation_receive');
assert.deepEqual(quotationPayload.pdf_options, [{attachment_id:'file',kitchen_type:'GI'},{attachment_id:'ss-file',kitchen_type:'SS'},{attachment_id:'mix-file',kitchen_type:'Mix'}]);
assert.equal(quotationPayload.final_attachment_id, 'mix-file');
for (const field of ['amount','received_date','upload_date','notes']) assert.equal(quotationPayload[field], undefined, `${field} is not manually submitted`);
assert.equal(quotationPayload.sent_status, 'No');
assert.equal(quotationPayload.shared_date, null);
view = render('quotation');
assert.equal(view.control('kitchen-quotation-shared-date').props.value, '2026-10-26');
view = view.refresh(undefined, true);
view.control('kitchen-quotation-GI-pdf').props.onAdd('file');
view = view.refresh(undefined, false);
assert.equal(view.control('kitchen-quotation-shared-date').props.value, '2026-10-26', 'A temporary upload lock cannot erase the untouched automatic quotation date when the first PDF initializes the draft');
view.control('kitchen-quotation-GI-pdf').props.onSelect('file');
view.control('kitchen-quotation-sent').props.onChange('Yes');
view.control('kitchen-version-response').props.onChange('Approved');
view = view.refresh();
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false);
await view.control('kitchen-quotation-receive').props.onPress();
assert.equal(calls.pop()[1].shared_date, '2026-10-26', 'Saving the uploaded quotation preserves the automatic date without a redundant picker interaction');
for (const lifecycle_status of ['On Hold', 'Cancelled']) {
  view = render('quotation', { lifecycle_status, quotation_versions: [{ ...quotation, response: 'Pending', shared_date: null }] });
  assert.equal(view.control('kitchen-quotation-shared-date').props.value, '', 'Inactive records preserve an unknown historical date');
  assert.equal(view.control('kitchen-quotation-shared-date').props.disabled, true);
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
assert.match(view.text, /Select final design and quotation PDFs/);
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
for (const retired of ['kitchen-design-edit-date','kitchen-design-edit-requirements','kitchen-design-edit-budget','kitchen-design-edit-notes','kitchen-design-edit-handoff']) assert.equal(view.control(retired),undefined);
assert.deepEqual(view.control('kitchen-design-sent').props.values,['Yes','No']);
view.control('kitchen-design-edit-response').props.onChange('Pending');
view = view.refresh();
assert.equal(view.control('kitchen-design-edit-save').props.disabled,true,'Sending to company requires customer approval');
assert.equal(view.control('kitchen-design-edit-approval-date'),undefined);
view.control('kitchen-design-sent').props.onChange('No');
view.control('kitchen-design-finalize').props.onPress();
view=view.refresh();
assert.equal(view.control('kitchen-design-edit-save').props.disabled,false);
await view.control('kitchen-design-edit-save').props.onPress();
assert.equal(calls.at(-1)[1].handoff_date,null);
for (const field of ['requirements','budget_discussion','notes','presentation_date']) assert.equal(calls.at(-1)[1][field],undefined,'Retired inputs do not overwrite stored history');
calls.length=0;
view=render('design',{design_versions:[]});
assert.equal(view.control('kitchen-design-present'),undefined,'Uploading a PDF creates its Design without a Save Design step');
assert.equal(view.control('kitchen-design-new-version'),undefined,'Design count is driven by PDFs, never a Create Design button');
await view.control('kitchen-design-pdf').props.onAdd('design-file');
assert.deepEqual(calls.pop(),['design_present',{attachment_ids:['design-file'],final_attachment_id:'design-file',handoff_status:'No'}]);
view=render('design',{design_versions:[{...design,response:'Pending',approval_date:null,shared_date:null,handoff_status:'No',handoff_date:null}],final_design_version_id:null});
assert.equal(view.control('kitchen-design-edit-shared').props.value,'2026-10-26');
view.control('kitchen-design-edit-shared').props.onChange('2026-10-25');
view.control('kitchen-design-edit-response').props.onChange('Approved');
view=view.refresh();
assert.equal(view.control('kitchen-design-edit-shared').props.value,'2026-10-25');
assert.equal(view.control('kitchen-design-edit-approval-date').props.value,'2026-10-26');
view.control('kitchen-design-finalize').props.onPress();
view=view.refresh();
assert.equal(view.control('kitchen-design-edit-save').props.disabled,true,'Final design requires Yes for company handoff');
view.control('kitchen-design-sent').props.onChange('Yes');
view=view.refresh();
await view.control('kitchen-design-edit-save').props.onPress();
assert.deepEqual([calls.at(-1)[0],calls.at(-1)[1].version_id,calls.at(-1)[1].finalize,calls.at(-1)[1].handoff_status],['design_update','design',true,'Yes']);
assert.equal(calls.at(-1)[1].handoff_date,undefined,'Server records handoff date');
calls.length=0;
view=render('design',{design_versions:[design,design2],quotation_versions:[quotation,quote2]});
view.control('kitchen-design-version').props.onChange(design.id);
view=view.refresh();
assert.match(view.text,/Linked quotations: Quotation 1/);
assert.equal(calls.length,0,'Viewing a design does not write');
await view.control('kitchen-design-edit-save').props.onPress();
assert.equal(calls.pop()[1].version_id,design.id,'Edits name the selected design ID');
view=render('design',{design_versions:[design],final_design_version_id:design.id},{'design.design.edit':{source:JSON.stringify([design,'another-design']),finalize:true,shared_date:design.shared_date,response:'Approved',approval_date:design.approval_date,handoff_status:'Yes'}});
assert.equal(view.control('kitchen-design-edit-save').props.disabled,true,'A different persisted final selection invalidates an older finalize draft even when the design record is unchanged');
assert.ok(view.control('kitchen-design-edit-reload'),'The stale final selection exposes explicit draft review');
const numberedDesigns=[];
const numberedAttachments=Array.from({length:5},(_,index)=>({id:`numbered-pdf-${index+1}`,filename:`Drawing ${index+1}.pdf`,content_type:'application/pdf',uploaded_at:'2026-10-26T10:00:00Z',size_bytes:1000}));
view=render('design',{design_versions:numberedDesigns,attachments:numberedAttachments,final_design_version_id:null},{},async(name,payload)=>{
  assert.equal(name,'design_present');assert.equal(payload.attachment_ids.length,1);
  numberedDesigns.push({id:`numbered-design-${numberedDesigns.length+1}`,number:numberedDesigns.length+1,attachment_ids:payload.attachment_ids,final_attachment_id:payload.final_attachment_id,response:'Pending',handoff_status:'No'});
  return true;
});
for(const file of numberedAttachments){await view.control('kitchen-design-pdf').props.onAdd(file.id);view=view.refresh();}
assert.deepEqual(view.control('kitchen-design-version').props.options.map(row=>row.label),[1,2,3,4,5].map(number=>`Design ${number} · Pending`),'Every PDF creates a numbered Design with no four-design cap');
view.control('kitchen-design-version').props.onChange('numbered-design-1');view=view.refresh();
assert.equal(view.control('kitchen-design-version').props.value,'numbered-design-1','An older uploaded design can be chosen while newer PDFs remain available');
assert.equal(view.control('kitchen-design-new-version'),undefined);
assert.equal(view.control('kitchen-design-present'),undefined);
view = render('quotation', { design_versions: [design, design2], quotation_versions: [quotation, quote2] });
assert.match(view.text, /Quotation 7/);
assert.match(view.text, /Finalized design · Design 2/, 'An existing quotation keeps its saved design association');
assert.equal(view.control('kitchen-quotation-final-design').props.file.id, design2.final_attachment_id);
for (const retired of ['kitchen-quotation-revision', 'kitchen-quotation-design-version']) assert.equal(view.control(retired), undefined);
assert.doesNotMatch(view.text, /Saved quotation|Related design/);
assert.equal(calls.length, 0, 'Opening the latest quotation changes no association');
view.control('kitchen-quotation-new-version').props.onPress();
view = view.refresh();
assert.ok(view.control('kitchen-quotation-receive'));
assert.match(view.text, /Finalized design · Design 1/, 'A new quotation uses the project’s finalized design automatically');
view = chooseQuotation(view);
await view.control('kitchen-quotation-receive').props.onPress();
assert.equal(calls.pop()[1].design_version_id, design.id, 'A new quotation saves the finalized design ID');
view.control('kitchen-quotation-cancel-new').props.onPress();
view = view.refresh();
assert.match(view.text, /Quotation 7/, 'Cancelling a new quotation returns to the latest saved quotation');
assert.match(view.text, /Finalized design · Design 2/);
view = render('quotation', { workflow_cycle: 2, final_design_version_id: design2.id, design_versions: [design, { ...design2, workflow_cycle: 2 }], quotation_versions: [quotation] });
view.control('kitchen-quotation-new-version').props.onPress();
view = view.refresh();
assert.match(view.text, /Finalized design · Design 2/, 'A new quotation after Return to Design uses the current work cycle');
view = chooseQuotation(view);
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false, 'Historical quotation viewing cannot trap new current-cycle quotation entry');
view = render('quotation', { design_versions: [design, design2], quotation_versions: [quotation], orders: [order] }, { 'quotation.quotation.edit': { source: JSON.stringify(quotation), design_version_id: design2.id, pdf_options: quotation.pdf_options, final_attachment_id: 'file', sent_status: 'Yes', shared_date: quotation.shared_date, response: 'Approved', notes: 'Unsaved basis draft' } });
assert.equal(view.control('kitchen-quotation-edit-save').props.disabled, false, 'Retired draft association fields cannot change an existing quotation’s saved basis');
await view.control('kitchen-quotation-edit-save').props.onPress();
assert.equal(calls.pop()[1].design_version_id, design.id, 'Even a retained draft from the old picker saves the order-bound quotation’s original design');
assert.match(view.text, /Finalized design · Design 1/, 'The order-bound display always shows the actual saved design once');
assert.doesNotMatch(view.text, /Related design/);
view = render('quotation', { final_design_version_id: null, design_versions: [design, design2] });
view = chooseQuotation(view);
view.control('kitchen-quotation-shared-date').props.onChange('2026-10-26');
view = view.refresh();
assert.equal(view.control('kitchen-quotation-receive').props.disabled, true, 'A missing final design blocks a new quotation');
assert.ok(view.control('kitchen-complete-design'));
view = view.refresh({ final_design_version_id: design.id });
assert.equal(view.control('kitchen-quotation-receive').props.disabled, false, 'Returning from finalizing a design restores a new quotation without a removed picker');
view = view.refresh({ final_design_version_id: design2.id });
assert.match(view.text, /Finalized design · Design 2/, 'A changed final design becomes the unsaved quotation’s basis');
assert.equal(view.control('kitchen-quotation-GI-pdf').props.finalId, 'file', 'Changing final design preserves quotation PDF entries');
assert.equal(view.control('kitchen-quotation-shared-date').props.value, '2026-10-26', 'Changing final design preserves quotation date entries');
await view.control('kitchen-quotation-receive').props.onPress();
assert.equal(calls.pop()[1].design_version_id, design2.id);
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
console.log('Kitchen commercial forms: mandatory PDF finalization, single GI/SS/Mix choice, automatic upload dates, selected version relationships, confirmation states, handoff dates, payment and work actions passed');

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
    let task=render(stage,{}, { [stage]: {status} }, async (...args)=>{commands.push(args);return true;});
    // Date fields initialize independently after mount; both functional updates must survive.
    task.control(`kitchen-${stage}-start`).props.onChange('2026-10-26');
    task.control(`kitchen-${stage}-complete`).props.onChange('2026-10-26');
    task = task.refresh();
    assert.equal(task.control(`kitchen-${stage}-start`).props.value,'2026-10-26');
    assert.equal(task.control(`kitchen-${stage}-complete`).props.value,'2026-10-26');
    await task.control(`kitchen-${stage}-save`).props.onPress();
    assert.deepEqual(commands,[[`${stage}_update`,{status,start_date:status==='Not Started'?null:'2026-10-26',completion_date:status==='Completed'?'2026-10-26':null,notes:null}]],'Proposed dates never change the selected status or violate the work API');
    task.control(`kitchen-${stage}-start`).props.onChange('');
    task.control(`kitchen-${stage}-complete`).props.onChange('');
    task = task.refresh();
    assert.equal(task.control(`kitchen-${stage}-start`).props.value,'', 'Clearing remains visible until the date is reopened');
    assert.equal(task.control(`kitchen-${stage}-complete`).props.value,'');
  }
}
