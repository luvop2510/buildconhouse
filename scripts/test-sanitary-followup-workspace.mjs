import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../app/(admin)/followups.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const followupViewControl = (');
const end = source.indexOf('  const paginationFooter =', start);
assert.ok(start > 0 && end > start);
const workspace = source.slice(start, end);
const componentNames = [...new Set([...workspace.matchAll(/<([A-Z]\w*)/g)].map(match => match[1]))];
const compiled = ts.transpileModule(`export function render(isSanitary, summaryOpen = true) { ${workspace} return workspaceAndFilters; }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const noop = () => {};
const exports = {};
const scope = {
  exports, require: () => ({ jsx: (component, props) => ({ component, ...props }), jsxs: (component, props) => ({ component, ...props }), Fragment: 'Fragment' }),
  isPhone: false, followupView: 'active', outcomeCounts: {}, staff: { role: 'sales' },
  workspace: 'all', hasTileFollowupWorkspaces: false, stats: null, mission: null,
  loading: false, rawItems: [], q: '', filtered: [], priorityFilter: 'all', categoryFilter: 'all', ownerFilter: 'all',
  priorityCounts: {}, assignees: [{ id: 'worker-1', full_name: 'Worker' }], activeFilterCount: 0, kpiFilter: 'all',
  CATEGORY_OPTIONS: [], selectedIds: new Set(), type: { caption: {} }, spacing: { sm: 8, md: 16 }, pagePad: 16,
  activeTileStyle: {}, router: { push: noop }, filterValues: () => [],
  setFollowupView: noop, setWorkspace: noop, onRefresh: noop, openSummary: noop, toggleKpi: noop, toggleSummary: noop,
  setQ: noop, setPriorityFilter: noop, setCategoryFilter: noop, setOwnerFilter: noop,
  ...Object.fromEntries(componentNames.map(name => [name, name])),
};
vm.runInNewContext(compiled, scope);
function flatten(node, result = []) {
  if (Array.isArray(node)) node.forEach(child => flatten(child, result));
  else if (node && typeof node === 'object') { result.push(node); flatten(node.children, result); }
  return result;
}

test('sanitary workspace shows salesperson filtering without summary, mission, priority or type', () => {
  const tree = flatten(exports.render(true));
  assert.ok(tree.some(node => node.testID === 'followups-salesperson' && node.label === 'SALESPERSON'));
  assert.ok(!tree.some(node => node.testID === 'followups-filters'));
  assert.ok(!tree.some(node => ['PRIORITY', 'TYPE', 'OWNER', "Today's Tasks", 'Overdue Tasks', 'Expiring Soon', 'Waiting For Customer', 'Summary'].includes(node.label)));
  assert.ok(!tree.some(node => node.component === 'MissionHero'));
});

test('other floor workspaces retain existing filters and optional summary', () => {
  const tree = flatten(exports.render(false));
  assert.ok(tree.some(node => node.label === 'PRIORITY'));
  assert.ok(tree.some(node => node.label === 'TYPE'));
  assert.ok(tree.some(node => node.component === 'MissionHero'));
});
