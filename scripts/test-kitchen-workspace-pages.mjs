import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KITCHEN_WORKSPACE_PAGES, KITCHEN_WORKSPACE_LANDING, KITCHEN_WORKSPACE_RESOURCE } from '../src/kitchen-workspace-pages.ts';
import { staffLandingPath } from '../src/access-profiles.ts';
import { moduleForRoute, hasGrantAccess, delegationPageLabels } from '../src/team-delegation.ts';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const stages = KITCHEN_WORKSPACE_PAGES.map(page => page.stage);
assert.equal(new Set(stages).size, stages.length);
const serverStages = [...read('backend/models_kitchen.py').match(/^STAGES = \(([^\n]+)\)/m)[1].matchAll(/"([^\"]+)"/g)].map(match => match[1]);
assert.deepEqual(stages, serverStages, 'Every backend stage must be represented in navigation and Team access');
for (const page of KITCHEN_WORKSPACE_PAGES) {
  assert.ok(page.label.trim());
  assert.ok(page.icon.trim());
  assert.equal(moduleForRoute(['(admin)', 'kitchen', 'stages', page.stage]), 'kitchen-projects');
  assert.equal(hasGrantAccess([{ resource: KITCHEN_WORKSPACE_RESOURCE, floor_id: 'second-floor', actions: ['view'] }], 'second-floor', KITCHEN_WORKSPACE_RESOURCE), true);
  assert.equal(hasGrantAccess([{ resource: KITCHEN_WORKSPACE_RESOURCE, floor_id: 'second-floor', actions: ['view'] }], 'first-floor', KITCHEN_WORKSPACE_RESOURCE), false);
}
assert.equal(staffLandingPath(null, [{ resource: KITCHEN_WORKSPACE_RESOURCE, floor_id: 'second-floor', actions: ['view'] }], 'second-floor'), KITCHEN_WORKSPACE_LANDING);
assert.equal(staffLandingPath(null, [{ resource: 'payments', floor_id: 'second-floor', actions: ['view'] }], 'second-floor'), '/(admin)/access', 'Unrelated historical pages must not silently grant Kitchen authority');
assert.match(read('src/design/navigation.ts'), /\.\.\.KITCHEN_WORKSPACE_PAGES\.map/);
assert.match(read('src/api/kitchenProjects.ts'), /KITCHEN_WORKSPACE_PAGES\.map/);
assert.match(read('src/components/FloorDelegationEditor.tsx'), /delegationPageLabels/);
console.log(`Kitchen workspace: ${stages.length} stages synchronized across backend, navigation, labels, landing and Team; floor isolation retained`);

const navSource = read('src/design/navigation.ts');
const registrySource = read('backend/services/access_grants.py');
const registeredResources = new Set([...registrySource.matchAll(/^    "([a-z_]+)": \{/gm)].map(match => match[1]));
const ownerPages = new Set(['team', 'team-assign', 'settings']);
for (const match of navSource.matchAll(/href: "([^"\n]+)", label: "([^"\n]+)"/g)) {
  const segments = match[1].split('/').filter(Boolean);
  if (ownerPages.has(segments.at(-1))) continue;
  const module = moduleForRoute(segments);
  const resource = module === 'payments-list' ? 'payments' : module?.replaceAll('-', '_');
  assert.ok(registeredResources.has(resource), `Navigation page ${match[2]} needs a registered delegation capability`);
}
const kitchenNav = KITCHEN_WORKSPACE_PAGES.map(page => ({ href: `/(admin)/kitchen/stages/${page.stage}`, label: page.label, floors: ['second-floor'] }));
assert.deepEqual(delegationPageLabels('kitchen_projects', 'second-floor', kitchenNav), KITCHEN_WORKSPACE_PAGES.map(page => page.label));
assert.deepEqual(delegationPageLabels('kitchen_projects', 'first-floor', kitchenNav), []);
assert.deepEqual(delegationPageLabels('payments', 'ground-floor', [{href:'/(admin)/payments',label:'Payments'}, {href:'/(admin)/payments-list',label:'Fully paid orders'}]), ['Payments','Fully paid orders']);
