import assert from 'node:assert/strict';
import { toggleFloor, togglePage, toggleAction, loadDelegation, hasGrantAccess, moduleForRoute } from '../src/team-delegation.ts';
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
  assert.equal(state.floorIds.length, state.grants.length);
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
assert.deepEqual(loadDelegation(['ground-floor', 'first-floor'], [
  { resource: 'payments', floor_id: null, actions: ['view', 'create'] },
  { resource: 'payments', floor_id: 'first-floor', actions: ['export'] },
  { resource: 'tiles', floor_id: 'first-floor', actions: ['view'] },
], [payments, tiles]).grants, [
  { resource: 'payments', floor_id: 'ground-floor', actions: ['view', 'create'] },
  { resource: 'payments', floor_id: 'first-floor', actions: ['view', 'create', 'export'] },
]);
assert.equal(staffLandingPath(null, []), '/(admin)/access');
assert.equal(staffLandingPath(null, [{ resource: 'payments', actions: ['view'], floor_id: 'ground-floor' }], 'first-floor'), '/(admin)/access');
assert.equal(staffLandingPath(null, [{ resource: 'payments', actions: ['view'], floor_id: 'ground-floor' }], 'ground-floor'), '/(admin)/payments');
assert.equal(staffLandingPath(null, [{ resource: 'notebook_walkins', actions: ['view'], floor_id: 'third-floor' }]), '/(admin)/notebook/furniture');
assert.equal(staffLandingPath(null, [{ resource: 'notebook_quotations', actions: ['view'], floor_id: 'second-floor' }]), '/(admin)/notebook/kitchen/quotation-follow-up');
assert.equal(staffLandingPath(null, [{ resource: 'furniture_quotations', actions: ['view'], floor_id: 'third-floor' }]), '/(admin)/notebook/furniture-quotations');
assert.equal(staffLandingPath('sanitary_purchases'), '/(admin)/purchases', 'existing profile landing preserved');
assert.equal(moduleForRoute(['(admin)', 'notebook', 'furniture', 'quotation-follow-up']), 'quotation-follow-up');
assert.equal(moduleForRoute(['(admin)', 'notebook', 'furniture']), 'furniture');
assert.equal(moduleForRoute(['(admin)', 'tiles', 'quotation']), 'tiles');
assert.equal(moduleForRoute(['(admin)', 'tiles', 'orders']), 'orders');
assert.equal(moduleForRoute(['(admin)', 'team']), 'restricted');
assert.equal(moduleForRoute(['(admin)', 'settings-company']), 'restricted');
assert.equal(moduleForRoute(['(admin)', 'settings-password']), null);
console.log(`Team delegation: ${cases} floor revocation combinations plus page/action, scoped navigation and landing checks passed`);
