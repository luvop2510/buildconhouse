import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
const labels = Object.fromEntries(stages.map(stage => [stage, stage[0].toUpperCase() + stage.slice(1)]));
const calls = [];
let stateValues = [], cursor = 0, effects = [], params = {}, editable = true, autosaveOptions;
const project = { id: 'project', customer_id: 'customer', reference: 'K-101', stage: 'cad', updated_at: '2026-10-27T01:00:00Z', customer: { name: 'Customer QA', phone: '9001112223', alternate_phone: 'removed-alt', email: 'removed-email', company: 'removed-company', property_name: 'removed-property', address: 'removed-address', city: 'removed-city', state: 'removed-state', pincode: 'removed-pin', gstin: 'removed-gst', notes: 'removed-notes', referrer_name: 'removed-reference' }, permissions: { can_update: true }, lead: {}, visit: {}, cad: {} };
const element = (type, props) => ({ type, props: props || {} });
const kitchenState = () => ({ id: project.id, project: { ...project, permissions: { can_update: editable } }, policy: {}, returnTo: '/kitchen', submission: { busy: false }, isDraftStale: () => false, resetDraftValue: () => {}, documentSubmission: { busy: false }, command: (...args) => calls.push(args) });
const router = { setParams: patch => calls.push(['params', patch]), push: href => calls.push(['navigate', href]), canGoBack: () => false };
const modules = {
  react: { createContext: () => ({}), useState: initial => { const index = cursor++; if (!(index in stateValues)) stateValues[index] = typeof initial === 'function' ? initial() : initial; return [stateValues[index], value => { stateValues[index] = typeof value === 'function' ? value(stateValues[index]) : value; }]; }, useRef: initial => ({ current: initial }), useEffect: effect => effects.push(effect), useCallback: fn => fn },
  'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
  'react-native': { View: 'view', ScrollView: 'scroll', Pressable: 'button', Platform: { OS: 'web' } },
  'expo-router': { useRouter: () => router, useLocalSearchParams: () => params, useFocusEffect: () => {} },
  '@expo/vector-icons/Feather': 'icon', '@/src/components/AppText': { Text: 'text' },
  '@/src/components/ds': { Alert: 'alert', ErrorState: 'error', EmptyState: 'empty', LoadingState: 'loading', SearchField: 'search', Sheet: 'sheet' },
  '@/src/design/navigationControls': { Menu: 'menu' }, '@/src/design/NavigationLink': { NavigationLink: 'link' },
  '@/src/hooks/use-permissions': { useActionAccess: () => editable },
  '@/src/state/auth': { useAuth: () => ({ staff: { role: 'owner' } }) },
  '@/src/design/responsive': { useBp: () => ({ isPhone: true }) },
  '@/src/theme/tokens': { spacing: {}, radius: {} },
  '@/src/api/kitchenProjects': { KITCHEN_STAGES: stages, STAGE_LABELS: labels, kitchenProjectsApi: { configuration: async () => ({}), assignees: async () => ({ rows: [] }), list: async query => { calls.push(['list', query]); return { rows: [], total: 0 }; } } },
  './shared': { KitchenFloor: 'floor', KitchenPage: 'page', KitchenPanel: 'panel', displayDate: value => value, errorText: String, useKitchenSubmission: () => ({}) },
  './KitchenPrimitives': { KitchenButton: 'button', KitchenTextField: 'field', kitchenColors: {}, kitchenType: {} },
  './KitchenDates': { kitchenToday: () => '2026-10-29' },
  './KitchenAutosave': { useKitchenAutosave: options => { autosaveOptions = options; return { status: 'pending' }; } },
  './KitchenProjectState': { useKitchenDraft: (key, initial) => [key === 'lead.value' ? { ...initial, notes: 'New note without a site', lead_date: '2026-10-29' } : initial, () => {}], useKitchenProject: kitchenState, kitchenStage: stage => stages.includes(stage) ? stage : null, kitchenProjectPath: (id, suffix) => `/kitchen/${id}${suffix}` },
  './KitchenCustomerSearch': { KitchenCustomerSearch: 'customer-search' },
};
const versionModule = {};
new Function('exports', ts.transpileModule(readFileSync(new URL('../src/components/kitchen/KitchenVersions.ts', import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(versionModule);
modules['./KitchenVersions'] = versionModule;
function load(file, internals = '') {
  const output = {};
  const source = readFileSync(new URL(`../src/components/kitchen/${file}.tsx`, import.meta.url), 'utf8') + internals;
  new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText)(name => modules[name] || {}, output);
  return output;
}
function render(component, props, values = []) { stateValues = values; cursor = 0; effects = []; return component(props); }
function nodes(tree) { if (tree == null || typeof tree === 'boolean') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); if (typeof tree !== 'object') return [String(tree)]; return [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.right)]; }
const find = (tree, id) => nodes(tree).find(node => node.props?.testID === id);
const text = tree => nodes(tree).filter(node => typeof node === 'string').join(' ');
const detail = load('KitchenProjectDetail', '\nexports.StageNavigation = StageNavigation; exports.EarlyStage = EarlyStage;');
for (const expanded of [false, true]) {
  params = { stage: 'cad', details: expanded ? '1' : '' };
  const tree = render(detail.KitchenProjectDetail, {});
  assert.ok(nodes(tree.props.children.props.right).some(node => node.props?.triggerTestID === 'kitchen-project-actions'), 'Project Actions stays in the top header with Details closed or open');
  assert.ok(find(tree, 'kitchen-project-stages'), 'All nine stages are reachable without opening Details');
  for (const stage of stages) assert.equal(find(tree, `kitchen-project-stage-${stage}`).props.href, `/kitchen/project/stages/${stage}`);
  const navigation = nodes(tree).find(node => node.type === detail.StageNavigation);
  assert.ok(navigation, 'Current-stage Previous/Next commands remain outside collapsed Details');
  const controls = render(detail.StageNavigation, navigation.props);
  find(controls, 'kitchen-previous-stage').props.onPress();
  assert.deepEqual(calls.pop(), ['move_stage', { target_stage: 'visit' }]);
  find(controls, 'kitchen-advance-design').props.onPress();
  assert.deepEqual(calls.pop(), ['move_stage', { target_stage: 'design' }]);
  const details = find(tree, 'kitchen-project-details');
  assert.equal(Boolean(details), expanded);
  if (expanded) { assert.match(text(details), /Customer QA.*9001112223/); assert.doesNotMatch(text(details), /removed-|Current stage|Target completion/); }
  assert.equal(find(tree, 'kitchen-customer-current-stage'), undefined);
}
editable = false;
assert.equal(nodes(render(detail.KitchenProjectDetail, {})).some(node => node.type === detail.StageNavigation), false, 'View-only users never receive mutation actions');
editable = true; params = { stage: 'visit' };
assert.equal(nodes(render(detail.KitchenProjectDetail, {})).some(node => node.type === detail.StageNavigation), false, 'Viewing historical records cannot move the project');
const workspace = load('KitchenWorkspace', '\nexports.Workspace = Workspace; exports.ProjectList = ProjectList;');
params = { search: 'Customer QA', page: '2', assignee: 'old-worker', status: 'Lost', attention: 'on_hold', stage: 'order', date_from: '2020-01-01' };
const queues = render(workspace.Workspace, { page: 'projects' });
assert.equal(find(queues, "kitchen-stage-navigation"), undefined, "Search queues do not repeat the nine-stage strip");
for (const stage of stages) assert.equal(find(queues, `kitchen-queue-stage-${stage}`), undefined);
const list = nodes(queues).find(node => node.type === workspace.ProjectList);
assert.deepEqual(list.props.values, { search: 'Customer QA', page: '2' }, 'Old filter bookmarks cannot hide projects');
const listTree = render(workspace.ProjectList, list.props);
assert.ok(find(listTree, 'kitchen-search'), 'Customer search remains available');
assert.equal(find(listTree, 'kitchen-filters-open'), undefined);
assert.equal(find(listTree, 'kitchen-filters'), undefined);
effects.forEach(effect => effect());
const query = calls.findLast(call => call[0] === 'list')[1];
assert.deepEqual(query, { search: 'Customer QA', sort: 'updated_at', direction: 'desc', page: 2, limit: 25 });
const dashboard = load('KitchenDashboard', '\nexports.DashboardContent = DashboardContent;');
const dashboardTree = render(dashboard.DashboardContent, {}, [390, { retry: 0, result: { stage_counts: {}, stage_customer_counts: {}, configured: true } }, false, null, 0]);
for (const stage of stages) assert.ok(find(dashboardTree, `kitchen-dashboard-stage-${stage}`));
assert.ok(nodes(dashboardTree).some(node => node.type === 'customer-search'));
assert.doesNotMatch(text(dashboardTree), /Needs attention|Pending manager approvals|Completion overdue|On hold/);
console.log('Kitchen simplified UI: nine stage links, explicit adjacent commands/permissions, compact customer identity, removed filter bookmark effects and dashboard attention passed.');

const finalDesign={id:'d1',response:'Approved',handoff_status:'Yes',handoff_date:'2026-10-28',attachment_ids:['design-pdf'],final_attachment_id:'design-pdf'};
for (const design of [undefined,{...finalDesign,final_attachment_id:null},{...finalDesign,handoff_status:'No'},finalDesign]) {
  const tree=render(detail.StageNavigation,{project:{...project,stage:'design',final_design_version_id:design?.id,design_versions:design?[design]:[]},disabled:false});
  assert.equal(find(tree,'kitchen-advance-quotation').props.disabled,design!==finalDesign,'Design movement requires final PDF, approval and Yes for company handoff');
}
const finalQuote={id:'q1',design_version_id:'d1',response:'Approved',shared_date:'2026-10-28',pdf_options:[{attachment_id:'quote-pdf',kitchen_type:'GI'}],final_attachment_id:'quote-pdf'};
for (const quote of [undefined,{...finalQuote,final_attachment_id:null},{...finalQuote,response:'Pending'},finalQuote]) {
  const tree=render(detail.StageNavigation,{project:{...project,stage:'quotation',final_design_version_id:'d1',design_versions:[finalDesign],quotation_versions:quote?[quote]:[]},disabled:false});
  assert.equal(find(tree,'kitchen-advance-order').props.disabled,quote!==finalQuote,'Quotation movement requires one final kitchen PDF and customer approval');
}
console.log('Kitchen PDF stage movement: missing file, No handoff and pending customer approval stay blocked.');
const replacementFinalDesign = {...finalDesign, id:'d2'};
const quotationProject = {...project, stage:'quotation', final_design_version_id:'d2', design_versions:[finalDesign,replacementFinalDesign], quotation_versions:[finalQuote]};
const changedFinalDesign = render(detail.StageNavigation,{project:quotationProject,disabled:false});
assert.equal(find(changedFinalDesign,'kitchen-advance-order').props.disabled,true,'Finalizing another design blocks Next until the working quotation is explicitly saved against it');
assert.match(text(changedFinalDesign),/Save quotation details.*current finalized design/);
const reboundQuotation = render(detail.StageNavigation,{project:{...quotationProject,quotation_versions:[{...finalQuote,design_version_id:'d2'}]},disabled:false});
assert.equal(find(reboundQuotation,'kitchen-advance-order').props.disabled,false,'Saving the matching design basis enables Next again');
const historicalOrder = {id:'o1',quotation_version_id:'q1',confirmed:true,status:'Confirmed'};
const boundQuotation = render(detail.StageNavigation,{project:{...quotationProject,orders:[historicalOrder]},disabled:false});
assert.equal(find(boundQuotation,'kitchen-advance-order').props.disabled,false,'Returning to an order-bound quotation retains its explicit historical design');
for(const fields of [{commercial_basis_invalidated:true},{orders:[{...historicalOrder,authorization_invalidated:true}]}]){
  const invalidatedBasis = render(detail.StageNavigation,{project:{...quotationProject,orders:[historicalOrder],...fields},disabled:false});
  assert.equal(find(invalidatedBasis,'kitchen-advance-order').props.disabled,true,'An invalidated historical order cannot bypass the current design save requirement');
}

const notSelected=render(detail.StageNavigation,{project:{...project,stage:'design',design_versions:[finalDesign]},disabled:false});
assert.equal(find(notSelected,'kitchen-advance-quotation').props.disabled,true,'An uploaded and approved design must also be explicitly finalized');
const newerPending={id:'d2',number:2,response:'Pending',handoff_status:'No',attachment_ids:['new-pdf'],final_attachment_id:'new-pdf'};
const chosenEarlier=render(detail.StageNavigation,{project:{...project,stage:'design',final_design_version_id:'d1',design_versions:[finalDesign,newerPending]},disabled:false});
assert.equal(find(chosenEarlier,'kitchen-advance-quotation').props.disabled,false,'A newer PDF does not replace the finalized earlier design');

const leadFields = load('KitchenLeadFields');
const leadTree = render(leadFields.LeadFields, { value: { status: 'New', site_location: 'Historical retained site' }, onChange: () => {} });
assert.equal(find(leadTree, 'kitchen-lead-site_location'), undefined, 'Site location is absent even for historical leads');
assert.ok(find(leadTree, 'kitchen-lead-date'), 'Lead date remains editable');
render(detail.EarlyStage, { project: { ...project, stage: 'lead', lead: { status: 'New' } }, stage: 'lead', disabled: false });
assert.equal(autosaveOptions.enabled, true, 'Routine lead notes and date autosave without a site');
autosaveOptions.save();
assert.deepEqual(calls.at(-1), ['edit_lead', { status: 'New', notes: 'New note without a site', lead_date: '2026-10-29' }, true]);
console.log('Kitchen lead forms omit site location and autosave notes/date without a site.');
