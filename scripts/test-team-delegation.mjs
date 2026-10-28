import assert from 'node:assert/strict';
import { toggleFloor, togglePage, toggleAction, loadDelegation, hasGrantAccess, moduleForRoute, resolveFloorRouteSegments, hasRouteDestination, isPersonalAccountRoute, personalAccountPath, isDelegationCatalog, delegationPagesForFloor, isResourceAssignable } from '../src/team-delegation.ts';
import { staffLandingPath } from '../src/access-profiles.ts';

const floors = ['ground-floor', 'first-floor', 'second-floor', 'third-floor'];
const payments = { key: 'payments', label: 'Payments', actions: ['view', 'create', 'update', 'delete', 'export'], floor_ids: floors };
const tiles = { key: 'tiles', label: 'Tile quotations', actions: ['view', 'create'], floor_ids: ['ground-floor'] };
const catalog = { key: 'catalog', label: 'Catalog', actions: ['view', 'update'], floor_ids: floors };
let cases = 0;
for (let mask = 0; mask < 16; mask++) {
  let state = { floorIds: [], grants: [] };
  for (let index = 0; index < floors.length; index++) state = toggleFloor(state, floors[index], Boolean(mask & (1 << index)));
  for (const floor of floors) state = togglePage(state, floor, payments, true);
  assert.equal(state.floorIds.filter(floor => floor !== "second-floor").length, state.grants.length);
  for (const grant of state.grants) assert.deepEqual(grant.actions, ['view']);
  for (const floor of floors) {
    const original = state;
    const revoked = toggleFloor(state, floor, false);
    assert.equal(revoked.grants.some(grant => grant.floor_id === floor), false);
    assert.deepEqual(revoked.grants, original.grants.filter(grant => grant.floor_id !== floor));
    const restored = toggleFloor(revoked, floor, true);
    assert.equal(restored.grants.some(grant => grant.floor_id === floor), false);
    assert.deepEqual(original, state); // transitions do not mutate saved drafts
    cases++;
  }
}
let state = toggleFloor({ floorIds: [], grants: [] }, 'ground-floor', true);
state = togglePage(state, 'ground-floor', payments, true);
state = togglePage(state, 'ground-floor', tiles, true);
state = toggleFloor(state, 'first-floor', true);
state = togglePage(state, 'first-floor', catalog, true);
state = togglePage(state, 'first-floor', tiles, true);
assert.equal(state.grants.length, 3, 'unsupported floor/page combination cannot be assigned');
state = toggleAction(state, 'ground-floor', payments, 'create', true);
state = toggleAction(state, 'ground-floor', payments, 'export', true);
const beforeRepeatedEnable = state;
state = togglePage(state, 'ground-floor', payments, true);
assert.strictEqual(state, beforeRepeatedEnable, 'repeated enable must preserve selected actions');
state = toggleAction(state, 'ground-floor', payments, 'view', false);
assert.deepEqual(state.grants[0].actions, ['view', 'create', 'export']);
state = toggleAction(state, 'ground-floor', tiles, 'delete', true);
assert.deepEqual(state.grants[1].actions, ['view'], 'unsupported action cannot be assigned');
state = togglePage(state, 'ground-floor', payments, false);
assert.equal(hasGrantAccess(state.grants, 'ground-floor', 'payments'), false);
assert.equal(hasGrantAccess(state.grants, 'first-floor', 'catalog', 'update'), false);
assert.equal(hasGrantAccess(state.grants, 'ground-floor', 'catalog'), false, 'another floor grant must not expose the page');
assert.equal(hasGrantAccess(state.grants, '', 'catalog'), false, 'unresolved floor fails closed');
assert.equal(hasGrantAccess(undefined, 'first-floor', 'catalog'), false);
assert.equal(hasGrantAccess([{ resource: 'quotations', floor_id: 'first-floor', actions: ['view', 'create'] }], 'first-floor', 'catalog'), false, 'builder lookups do not grant Catalog navigation');
assert.equal(hasGrantAccess([{ resource: 'quotations', floor_id: 'first-floor', actions: ['view', 'create'] }], 'first-floor', 'customers'), false, 'builder lookups do not grant Customers navigation');
assert.deepEqual(loadDelegation(['ground-floor', 'first-floor'], [
  { resource: 'payments', floor_id: null, actions: ['view', 'create'] },
  { resource: 'payments', floor_id: 'first-floor', actions: ['export'] },
  { resource: 'tiles', floor_id: 'first-floor', actions: ['view'] },
], [payments, tiles]).grants, [
  { resource: 'payments', floor_id: 'ground-floor', actions: ['view', 'create'] },
  { resource: 'payments', floor_id: 'first-floor', actions: ['view', 'create', 'export'] },
]);
for (const floor of floors) assert.equal(staffLandingPath(null, [{ resource: 'walkins', floor_id: floor, actions: ['view'] }], floor), floor === 'second-floor' ? '/(admin)/access' : '/(admin)/walkins', 'Kitchen only admits the connected Kitchen workflow; other floors retain Walk-ins');
assert.equal(staffLandingPath(null, [{ resource: 'kitchen_projects', floor_id: 'second-floor', actions: ['view'] }], 'second-floor'), '/(admin)/kitchen');
assert.equal(staffLandingPath(null, []), '/(admin)/access');
assert.equal(staffLandingPath(null, [{ resource: 'payments', actions: ['view'], floor_id: 'ground-floor' }], 'first-floor'), '/(admin)/access');
assert.equal(staffLandingPath(null, [{ resource: 'payments', actions: ['view'], floor_id: 'ground-floor' }], 'ground-floor'), '/(admin)/payments');
assert.equal(staffLandingPath(null, [{ resource: 'notebook_walkins', actions: ['view'], floor_id: 'third-floor' }]), '/(admin)/access');
assert.equal(staffLandingPath(null, [{ resource: 'notebook_quotations', actions: ['view'], floor_id: 'second-floor' }]), '/(admin)/access');
assert.equal(staffLandingPath(null, [{ resource: 'furniture_quotations', actions: ['view'], floor_id: 'third-floor' }]), '/(admin)/notebook/furniture-quotations');
assert.equal(staffLandingPath('sanitary_purchases'), '/(admin)/purchases', 'existing profile landing preserved');
assert.equal(moduleForRoute(['(admin)', 'notebook', 'furniture', 'quotation-follow-up']), 'followups');
assert.equal(moduleForRoute(['(admin)', 'notebook', 'furniture']), 'walkins');
assert.equal(moduleForRoute(['(admin)', 'tiles', 'quotation']), 'tiles');
assert.equal(moduleForRoute(['(admin)', 'tiles', 'orders']), 'orders');
assert.equal(moduleForRoute(['(admin)', 'team']), 'restricted');
assert.equal(moduleForRoute(['(admin)', 'settings-company']), 'restricted');
assert.equal(moduleForRoute(['(admin)', 'settings-password']), null);
assert.equal(hasRouteDestination([]), false);
assert.equal(hasRouteDestination(['(admin)']), false);
assert.equal(hasRouteDestination(['(admin)', 'settings']), true);
assert.equal(hasRouteDestination(['(admin)', 'unknown-page']), true, 'unknown resolved routes must reach the denial check');
for (const page of ['settings', 'settings-password', 'settings-mfa', 'settings-privacy', 'settings-terms', 'access']) {
  assert.equal(isPersonalAccountRoute(['(admin)', page]), true);
  assert.equal(moduleForRoute(['(admin)', page]), null);
}
for (const segments of [[], ['(admin)'], ['(admin)', 'catalog'], ['(admin)', 'settings-company'], ['(admin)', 'catalog', 'settings'], ['(admin)', 'unknown-page']]) {
  assert.equal(isPersonalAccountRoute(segments), false);
}
assert.equal(moduleForRoute(['(admin)', 'catalog', 'settings']), 'catalog');
assert.equal(moduleForRoute(['(admin)', 'unknown-page']), 'restricted');
assert.equal(personalAccountPath('/settings'), '/settings');
assert.equal(personalAccountPath('/settings-password/'), '/settings-password');
assert.equal(personalAccountPath('/(admin)/settings-mfa'), '/settings-mfa');
for (const path of [undefined, '/', '/catalog', '/settings-company', '/catalog/settings', '/unknown', '/settings/unknown']) assert.equal(personalAccountPath(path), null);
const delegationFloors = floors.map(id => ({ id, name: id }));
const validCatalog = { resources: [payments, tiles], action_descriptions: Object.fromEntries(['view', 'create', 'update', 'delete', 'export'].map(action => [action, `Can ${action}`])) };
assert.equal(isDelegationCatalog(validCatalog, delegationFloors), true);
for (const invalidCatalog of [null, {}, { ...validCatalog, resources: [] },
  { ...validCatalog, resources: [payments, payments] },
  { ...validCatalog, resources: [{ ...payments, actions: ['view', 'typo'] }] },
  { ...validCatalog, resources: [{ ...payments, floor_ids: ['unknown-floor'] }] },
  { ...validCatalog, resources: [{ ...payments, label: '' }] },
  { ...validCatalog, action_descriptions: { view: 'View only' } },
]) assert.equal(isDelegationCatalog(invalidCatalog, delegationFloors), false, 'incomplete catalog must block saving');
console.log(`Team delegation: ${cases} floor revocation combinations plus page/action, scoped navigation and landing checks passed`);

for (const floor of ["kitchen", "furniture"]) {
  const resolved = resolveFloorRouteSegments(["(admin)", "notebook", "[floor]"], floor);
  assert.equal(moduleForRoute(resolved), "walkins");
  assert.equal(resolved.includes(floor), true, "floor-switch compatibility needs the resolved floor");
  assert.equal(moduleForRoute(resolveFloorRouteSegments(["(admin)", "notebook", "[floor]", "quotation-follow-up"], floor)), "followups");
}
assert.equal(moduleForRoute(resolveFloorRouteSegments(["(admin)", "notebook", "[floor]"], "unknown")), "restricted");
assert.deepEqual(resolveFloorRouteSegments(["(admin)", "catalog", "[id]"], "kitchen"), ["(admin)", "catalog", "[id]"]);

const legacyNotebook = { key: 'notebook_walkins', label: 'Legacy notebook', floor_ids: ['third-floor'], actions: ['view', 'create', 'update'], retired: true };
const historical = { floorIds: ['third-floor'], grants: [{ resource: 'notebook_walkins', floor_id: 'third-floor', actions: ['view', 'update'] }] };
assert.deepEqual(togglePage({ floorIds: ['third-floor'], grants: [] }, 'third-floor', legacyNotebook, true).grants, []);
assert.deepEqual(loadDelegation(historical.floorIds, historical.grants, [legacyNotebook]), historical);
assert.deepEqual(toggleAction(historical, 'third-floor', legacyNotebook, 'create', true), historical);
assert.deepEqual(togglePage(historical, 'third-floor', legacyNotebook, false).grants, []);

assert.equal(staffLandingPath(null, [{ resource: 'notebook_walkins', actions: ['view'], floor_id: 'third-floor' }, { resource: 'followups', actions: ['view'], floor_id: 'third-floor' }], 'third-floor'), '/(admin)/followups');
assert.equal(staffLandingPath(null, [{ resource: 'purchases', actions: ['view'], floor_id: 'ground-floor' }], 'ground-floor'), '/(admin)/access');

const currentKitchen = { key: 'kitchen_projects', label: 'Kitchen workspace', actions: ['view', 'create', 'update', 'export'], floor_ids: ['second-floor'], assignable_floor_ids: ['second-floor'] };
const compatibilityPayments = { ...payments, assignable_floor_ids: ['ground-floor', 'first-floor', 'third-floor'] };
assert.deepEqual(delegationPagesForFloor([compatibilityPayments, currentKitchen], [], 'second-floor'), [currentKitchen]);
const historicGrant = { resource: 'payments', actions: ['view', 'update'], floor_id: 'second-floor' };
const historicState = loadDelegation(['second-floor'], [historicGrant], [compatibilityPayments, currentKitchen]);
assert.deepEqual(historicState.grants, [historicGrant], 'catalog presentation must round-trip old grants');
assert.deepEqual(delegationPagesForFloor([compatibilityPayments, currentKitchen], historicState.grants, 'second-floor'), [compatibilityPayments, currentKitchen]);
assert.equal(isResourceAssignable(compatibilityPayments, 'second-floor'), false);
assert.deepEqual(togglePage(historicState, 'second-floor', compatibilityPayments, false).grants, []);
assert.deepEqual(togglePage({ floorIds: ['second-floor'], grants: [] }, 'second-floor', compatibilityPayments, true).grants, []);
assert.equal(isDelegationCatalog({ resources: [{ ...currentKitchen, assignable_floor_ids: ['first-floor'] }], action_descriptions: {view:'Read',create:'Add',update:'Edit',export:'Download'} }, floors.map(id => ({id,name:id}))), false);
await import('./test-kitchen-workspace-pages.mjs');
console.log('Kitchen catalog preserves existing access and rejects obsolete new assignments');

for (const floor of floors) {
  assert.equal(staffLandingPath(null, [{ resource: 'notifications', floor_id: floor, actions: ['view'] }], floor), '/(admin)/access', 'Retired-only notification grants have a stable landing');
}
assert.equal(staffLandingPath(null, [{ resource: 'followups', floor_id: 'second-floor', actions: ['view'] }], 'second-floor'), '/(admin)/access', 'Kitchen follow-up grants cannot choose a retired page');
