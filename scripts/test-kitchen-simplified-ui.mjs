import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
const labels = Object.fromEntries(stages.map(stage => [stage, stage[0].toUpperCase() + stage.slice(1)]));
const calls = [];
let stateValues = [], cursor = 0, effects = [], params = {}, editable = true;
const project = { id: 'project', customer_id: 'customer', reference: 'K-101', stage: 'cad', updated_at: '2026-10-27T01:00:00Z', customer: { name: 'Customer QA', phone: '9001112223', alternate_phone: 'removed-alt', email: 'removed-email', company: 'removed-company', property_name: 'removed-property', address: 'removed-address', city: 'removed-city', state: 'removed-state', pincode: 'removed-pin', gstin: 'removed-gst', notes: 'removed-notes', referrer_name: 'removed-reference' }, permissions: { can_update: true }, lead: {}, visit: {}, cad: {} };
const element = (type, props) => ({ type, props: props || {} });
const kitchenState = () => ({ id: project.id, project: { ...project, permissions: { can_update: editable } }, policy: {}, returnTo: '/kitchen', submission: { busy: false }, command: (...args) => calls.push(args) });
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
  './KitchenProjectState': { useKitchenProject: kitchenState, kitchenStage: stage => stages.includes(stage) ? stage : null, kitchenProjectPath: (id, suffix) => `/kitchen/${id}${suffix}` },
  './KitchenCustomerSearch': { KitchenCustomerSearch: 'customer-search' },
};
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
const detail = load('KitchenProjectDetail', '\nexports.StageNavigation = StageNavigation;');
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
