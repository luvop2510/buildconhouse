import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const element = (type, props) => ({ type, props: props || {} });
const modules = {
  'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
  'react-native': { View: 'view', useWindowDimensions: () => ({ fontScale: 1 }) },
  '@/src/design/graphics': { HalfGauge: 'gauge', SegmentedMeter: 'meter' },
  '@/src/design/components': { Surface: 'surface', Txt: 'text', Skeleton: 'skeleton' },
  '@/src/design/tokens': { color: { action: '#0066CC', inkMid: '#545458', inkSoft: '#626267' }, space: {} },
  '@/src/design/responsive': { useBp: () => ({ isPhone: true, width: 390 }) },
};
function load(path) {
  const output = {};
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function('require', 'exports', js)(name => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, output);
  return output;
}
const visuals = load('src/design/kitchenStageColors.ts');
modules['@/src/design/kitchenStageColors'] = visuals;
const expected = { lead: '#64748B', visit: '#F59E0B', design: '#8B5CF6', quotation: '#06B6D4',
  order: '#2563EB', production: '#F97316', installation: '#14B8A6', completed: '#22C55E' };
for (const [stage, colour] of Object.entries(expected)) assert.equal(visuals.kitchenStageColor(stage), colour);
assert.equal(new Set(Object.values(visuals.KITCHEN_STAGE_COLORS)).size, 9, 'CAD retains a distinct ninth colour');
assert.equal(visuals.kitchenStageColor('CAD File'), visuals.KITCHEN_STAGE_COLORS.cad);
assert.equal(visuals.kitchenStageColor('unknown'), undefined);
const { WorkflowDistribution } = load('src/components/today/TodayGraphics.tsx');
function nodes(tree) {
  if (tree == null || typeof tree === 'boolean') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree !== 'object') return [tree];
  return [tree, ...nodes(tree.props?.children)];
}
const find = (tree, id) => nodes(tree).find(node => node.props?.testID === id);
const stages = Object.keys(visuals.KITCHEN_STAGE_COLORS);
for (const statuses of [
  stages.map((status, index) => ({ status, count: index + 1 })),
  [...stages].reverse().map((status, index) => ({ status, count: index % 3 ? 0 : 13 })),
  [{ status: 'quotation', count: 2 }, { status: 'order', count: 17 }],
]) {
  const total = statuses.reduce((sum, row) => sum + row.count, 0);
  const tree = WorkflowDistribution({ workflow: { resource: 'kitchen_projects', label: 'Kitchen projects', total, statuses } });
  const meter = find(tree, 'today-workflow-meter-kitchen_projects');
  assert.equal(meter.props.values.reduce((sum, row) => sum + row.value, 0), total);
  for (const [index, row] of statuses.entries()) {
    const swatch = find(tree, `today-workflow-swatch-kitchen_projects-${row.status}`);
    assert.equal(swatch.props.style.backgroundColor, visuals.KITCHEN_STAGE_COLORS[row.status]);
    assert.equal(meter.props.values[index].color, swatch.props.style.backgroundColor, 'Legend and progress marks agree');
    assert.equal(meter.props.values[index].value, row.count, 'Dynamic quantities are unchanged');
    assert.ok(meter.props.label.includes(`${visuals.kitchenStageLabel(row.status)}: ${row.count}`));
    assert.ok(nodes(find(tree, `today-workflow-stage-kitchen_projects-${row.status}`)).includes(row.count.toLocaleString('en-IN')));
  }
}
const nonKitchen = WorkflowDistribution({ workflow: { resource: 'purchases', label: 'Purchases', total: 1, statuses: [{ status: 'order', count: 1 }] } });
assert.equal(find(nonKitchen, 'today-workflow-swatch-purchases-order').props.style.backgroundColor, '#0066CC', 'Other departments retain their palette');

let stateIndex = 0;
modules.react = { useState: () => [[false, true, false][stateIndex++], () => {}] };
modules['@/src/components/AppText'] = { Text: 'text' };
modules['@/src/components/ui'] = { Button: 'button' };
modules['@/src/api/salesAnalytics'] = { salesAnalyticsApi: {} };
modules['@/src/theme/tokens'] = { colors: {}, spacing: {}, type: {} };
modules['./AnalyticsParts'] = { analyticNumber: String, chartColors: { primary: '#0066CC' }, Panel: 'panel', ReadState: 'read', Empty: 'empty' };
modules['@/src/components/ui/dashboard-1'] = { MarketingDashboard: 'marketing' };
modules['./useAnalytics'] = { useAnalyticsRead: () => ({ data: {
  open_followups: 0, completed_followups: 0, dismissed_followups: 0, overdue_followups: 0, team: [], notes: [],
  workflows: [{ floor_id: 'second-floor', name: 'Kitchen', unit: 'projects', total: 45,
    stages: stages.map((id, index) => ({ id, name: visuals.kitchenStageLabel(id), count: index + 1 })) }],
} }) };
const { OwnerOperations } = load('src/components/salesAnalytics/OwnerOperations.tsx');
const owner = OwnerOperations({ floorId: 'second-floor' });
for (const [index, stage] of stages.entries()) {
  const bar = find(owner, `analytics-workflow-stage-second-floor-${stage}`);
  assert.equal(bar.props.style.backgroundColor, visuals.KITCHEN_STAGE_COLORS[stage]);
  assert.equal(bar.props.style.width, `${(index + 1) / 9 * 100}%`);
}
console.log('Kitchen stage colours: nine unique stable colours, matched legend/progress, dynamic counts, and shared owner visualization passed.');
