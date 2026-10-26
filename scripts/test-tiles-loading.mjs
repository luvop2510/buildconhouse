import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const referrerExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/referrer.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: referrerExports });

const source = readFileSync(new URL('../app/(admin)/tiles/index.tsx', import.meta.url), 'utf8');
const marker = '  return (\n    <SafeAreaView';
assert.ok(source.includes(marker));
const compiled = ts.transpileModule(source.replace(marker, '  return { documents, loading, selectedLoading, loadErrors, load, setDocumentType };\n' + marker), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function screen() {
  const hooks = [], effects = [], requests = [];
  let index = 0, dirty = false, state, ready = false, completed = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const slot = index++; hooks[slot] ||= { value: initial }; return [hooks[slot].value, value => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps }; return hooks[slot].value; },
  };
  const focus = callback => { const slot = index++; if (hooks[slot]?.callback !== callback) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { callback }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); }); } };
  const modules = {
    react, 'react/jsx-runtime': { jsx: () => null },
    'react-native': { StyleSheet: { create: value => value } },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({ view: completed ? 'completed' : 'pending' }), useFocusEffect: focus },
    '@/src/hooks/use-floor-access': { useRequireFloorAccessState: () => ({ ready }) },
    '@/src/design/responsive': { useBp: () => ({}) },
    '@/src/theme/tokens': { colors: {}, radius: {}, spacing: {}, type: {} },
    '@/src/utils/filters': { filterValues: value => value === 'all' ? [] : [value] },
    '@/src/api/client': { api: { get: (url, options) => { const pending = deferred(); requests.push({ ...pending, url, options }); return pending.promise; } } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: id => modules[id] || {} });
  const render = () => { index = 0; dirty = false; state = exports.default(); while (effects.length) effects.shift()(); return state; };
  return { requests, render, get state() { return state; }, ready(value) { ready = value; render(); }, completed(value) { completed = value; render(); }, async settle() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); if (dirty) render(); } } };
}

test('Ground Floor list waits for access, publishes quotation before selection settles, and preserves it after selection failure/retry', async () => {
  const fixture = screen(); fixture.render(); assert.equal(fixture.requests.length, 0);
  fixture.ready(true); assert.equal(fixture.requests.length, 2);
  fixture.requests[1].resolve([{ id: 'quote', doc_type: 'tiles_quotation', updated_at: '2026-10-16' }]); await fixture.settle();
  assert.equal(fixture.state.documents.tiles_quotation[0].id, 'quote');
  fixture.requests[0].reject({ detail: 'Selection unavailable' }); await fixture.settle();
  assert.equal(fixture.state.loadErrors.tiles_selection, 'Selection unavailable');
  assert.equal(fixture.state.documents.tiles_quotation[0].id, 'quote');
  const retry = fixture.state.load(); assert.equal(fixture.state.documents.tiles_quotation[0].id, 'quote');
  fixture.requests[2].resolve([{ id: 'selection' }]); fixture.requests[3].resolve([{ id: 'quote' }]); await retry; await fixture.settle();
  assert.equal(fixture.state.documents.tiles_selection[0].id, 'selection');
  assert.equal(Object.keys(fixture.state.loadErrors).length, 0);
  assert.ok(fixture.requests.every(request => request.options.floorId === 'ground-floor'));
});

test('old lifecycle/floor callbacks cannot overwrite new documents or start retained requests', async () => {
  const fixture = screen(); fixture.render(); fixture.ready(true);
  const oldLoad = fixture.state.load;
  fixture.completed(true); assert.equal(fixture.requests.length, 4);
  await oldLoad(); assert.equal(fixture.requests.length, 4);
  fixture.requests[2].resolve([]); fixture.requests[3].resolve([{ id: 'completed' }]); await fixture.settle();
  fixture.requests[0].resolve([{ id: 'old-selection' }]); fixture.requests[1].reject({ detail: 'Old failure' }); await fixture.settle();
  assert.equal(fixture.state.documents.tiles_quotation[0].id, 'completed');
  assert.equal(Object.keys(fixture.state.loadErrors).length, 0);
  fixture.ready(false); await oldLoad(); assert.equal(fixture.requests.length, 4);
});

const builderSource = readFileSync(new URL('../src/components/tiles/TilesDocBuilder.tsx', import.meta.url), 'utf8');
const builderCompiled = ts.transpileModule(builderSource.replace('function useTilesDoc(', 'export function useTilesDoc('), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function builder() {
  const hooks = [], effects = [], requests = [], timers = new Map(), parameterUpdates = [];
  let index = 0, dirty = false, state, params = {}, nextTimer = 1;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const slot = index++; hooks[slot] ||= { value: initial }; return [hooks[slot].value, value => { const next = typeof value === 'function' ? value(hooks[slot].value) : value; if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; } }]; },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps }; return hooks[slot].value; },
    useMemo(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback(), deps }; return hooks[slot].value; },
    useEffect(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const cleanup = hooks[slot]?.cleanup; hooks[slot] = { deps }; effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); }); } },
  };
  const request = method => (url, payload, options) => { const pending = deferred(); requests.push({ ...pending, method, url, payload, options }); return pending.promise; };
  const router = { setParams(value) { parameterUpdates.push(value); params = { ...params, ...value }; dirty = true; }, replace() {}, push() {} };
  const modules = {
    '@/src/utils/referrer': referrerExports,
    react, 'react-native': { StyleSheet: { create: value => value }, Platform: { OS: 'web' } },
    'expo-router': { useRouter: () => router, useLocalSearchParams: () => params },
    '@/src/api/client': { api: { get: (url, options) => { if (url === '/customers') return Promise.resolve([]); return request('GET')(url, undefined, options); }, post: request('POST'), patch: request('PATCH') } },
    '@/src/components/Toast': { toast: { error() {}, show() {}, success() {} } },
    '@/src/components/quotation/helpers/autosave': { enqueueQuotationPersist(queue, run) { const next = queue.current.then(run, run); queue.current = next; return next; } },
    '@/src/components/quotation/helpers/totals': { computeQuotationTotals: () => ({ subtotal: 0, grandTotal: 0, transportation: 0 }) },
    '@/src/theme/tokens': { font: {}, colors: {}, radius: {}, spacing: {}, type: new Proxy({}, { get: () => ({}) }) },
    '@/src/constants/floors': { TILES_FLOOR_ID: 'ground-floor' },
    './tilePresentation': { TILE_IMAGE_ASPECT_RATIO: 1.6 },
    './tilesStage': { tilesStage: () => ({}), nextTilesAction: () => null, canPlaceOrder: () => false, normalizeTilesStatus: value => value },
  };
  const exports = {};
  vm.runInNewContext(builderCompiled, { exports, require: id => modules[id] || {}, AbortController, setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  const render = () => { index = 0; dirty = false; state = exports.useTilesDoc('tiles_quotation'); while (effects.length) effects.shift()(); return state; };
  return { requests, parameterUpdates, render, navigate(id) { params = { id }; render(); }, unmount() { for (const hook of hooks) hook.cleanup?.(); }, get state() { return state; }, async settle() { for (let pass = 0; pass < 16; pass++) { await Promise.resolve(); if (dirty) render(); } }, fireAutosave() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

test('first tile autosave keeps newer draft edits when the created id updates the route', async () => {
  const fixture = builder(); fixture.render();
  fixture.state.pickCustomer({ id: 'customer', name: 'Original customer', phone: '123' });
  fixture.state.setHeaderField('address', 'Original address'); await fixture.settle();
  fixture.fireAutosave(); await fixture.settle();
  const create = fixture.requests.find(request => request.method === 'POST');
  assert.ok(create); assert.equal(create.url, '/quotations');
  assert.equal(create.payload.address_snapshot, 'Original address');
  fixture.state.setHeaderField('address', 'New address typed during save'); await fixture.settle();
  create.resolve({ id: 'self-created', number: 'TQ-001' }); await fixture.settle();
  assert.equal(fixture.state.header.address, 'New address typed during save');
  assert.equal(fixture.requests.filter(request => request.method === 'GET').length, 0, 'Own id transition must not restore the older server snapshot');
  fixture.fireAutosave(); await fixture.settle();
  const patch = fixture.requests.find(request => request.method === 'PATCH');
  assert.equal(patch.url, '/quotations/self-created');
  assert.equal(patch.payload.address_snapshot, 'New address typed during save');
  assert.equal(patch.options.floorId, 'ground-floor');
  patch.resolve({ subtotal: 0, grand_total: 0 }); await fixture.settle();
});

test('empty quotation result settles its own view while optional selections remain pending', async () => {
  const fixture = screen(); fixture.render(); fixture.ready(true);
  fixture.requests[1].resolve([]); await fixture.settle();
  assert.equal(fixture.state.selectedLoading, false);
  assert.equal(fixture.state.loading, true);
});
const restoredDoc = id => ({ id, number: id, doc_type: 'tiles_quotation', customer_id: `customer-${id}`, customer_name: `Customer ${id}`, phone_snapshot: '123', address_snapshot: `Address ${id}`, items: [] });

test('a held customer correction cannot save document A into newly opened document B', async () => {
  const fixture = builder(); fixture.render(); fixture.navigate('A');
  fixture.requests[0].resolve(restoredDoc('A')); await fixture.settle();
  fixture.state.setHeaderField('customerName', 'Corrected A'); await fixture.settle();
  fixture.fireAutosave(); await fixture.settle();
  const customerPatch = fixture.requests[1]; assert.equal(customerPatch.url, '/customers/customer-A');
  fixture.navigate('B'); fixture.requests[2].resolve(restoredDoc('B')); await fixture.settle();
  customerPatch.resolve({}); await fixture.settle();
  assert.equal(fixture.requests.length, 3, 'Stale customer completion must not start a quotation write');
  assert.equal(fixture.state.header.customerName, 'Customer B');
  assert.equal(fixture.state.docId, 'B');
});

test('a held quotation create cannot republish its old route after navigation or unmount', async () => {
  for (const leave of ['navigate', 'unmount']) {
    const fixture = builder(); fixture.render();
    fixture.state.pickCustomer({ id: 'customer', name: 'Original customer' });
    fixture.state.setHeaderField('address', 'Address'); await fixture.settle();
    fixture.fireAutosave(); await fixture.settle();
    const create = fixture.requests[0]; assert.equal(create.url, '/quotations');
    if (leave === 'navigate') { fixture.navigate('B'); fixture.requests[1].resolve(restoredDoc('B')); await fixture.settle(); }
    else fixture.unmount();
    create.resolve({ id: 'old-create', number: 'TQ-old' }); await fixture.settle();
    assert.equal(fixture.parameterUpdates.length, 0);
    if (leave === 'navigate') assert.equal(fixture.state.docId, 'B');
  }
});


test('returning A after B does not revive A’s older in-flight save', async () => {
  const fixture = builder(); fixture.render(); fixture.navigate('A');
  fixture.requests[0].resolve(restoredDoc('A')); await fixture.settle();
  fixture.state.setHeaderField('customerName', 'Obsolete A'); await fixture.settle();
  fixture.fireAutosave(); await fixture.settle();
  const customerPatch = fixture.requests[1];
  fixture.navigate('B'); fixture.requests[2].resolve(restoredDoc('B')); await fixture.settle();
  fixture.navigate('A'); fixture.requests[3].resolve(restoredDoc('A')); await fixture.settle();
  customerPatch.resolve({}); await fixture.settle();
  assert.equal(fixture.requests.length, 4);
  assert.equal(fixture.state.header.customerName, 'Customer A');
});

for (const kind of ['architect', 'interior_designer']) {
  test(`tile partner selection autosaves actual ${kind} identity and restores its saved display fields`, async () => {
    const fixture = builder(); fixture.render(); fixture.navigate('partner-doc');
    fixture.requests[0].resolve(restoredDoc('partner-doc')); await fixture.settle();
    const partner = { id: `existing-${kind}`, type: kind, name: `Saved ${kind}`, company: 'Existing studio' };
    fixture.state.pickPartner(partner); await fixture.settle();
    fixture.fireAutosave(); await fixture.settle();
    const saved = fixture.requests.find(request => request.method === 'PATCH');
    assert.equal(saved.url, '/quotations/partner-doc');
    assert.equal(saved.payload.referrer_id, partner.id);
    assert.equal(saved.payload.referrer_type, kind);
    assert.equal(saved.options.floorId, 'ground-floor');
    assert.equal(fixture.requests.filter(request => request.method === 'POST').length, 0, 'Selecting an existing contact must not create a referrer or customer');
    saved.resolve({ subtotal: 0, grand_total: 0 }); await fixture.settle();
    const restored = builder(); restored.render(); restored.navigate('partner-doc');
    restored.requests[0].resolve({ ...restoredDoc('partner-doc'), referrer_id: partner.id, referrer_type: kind, referrer_name: partner.name, referrer_company: partner.company });
    await restored.settle();
    assert.equal(restored.state.partner.id, partner.id);
    assert.equal(restored.state.partner.type, kind);
    assert.equal(restored.state.partner.name, partner.name);
    assert.equal(restored.state.partner.company, partner.company);
    restored.state.pickPartner(null); await restored.settle();
    restored.fireAutosave(); await restored.settle();
    const cleared = restored.requests.find(request => request.method === 'PATCH');
    assert.equal(cleared.payload.referrer_id, '', 'Explicit removal must send an empty ID rather than omit the update');
    assert.equal(cleared.payload.referrer_type, null);
    cleared.resolve({ subtotal: 0, grand_total: 0 }); await restored.settle();
  });
}

test('first tile creation persists an explicitly chosen partner with a follow-up patch', async () => {
  const fixture = builder(); fixture.render();
  fixture.state.pickCustomer({ id: 'customer', name: 'Original customer', phone: '123' });
  fixture.state.setHeaderField('address', 'Tile partner create address');
  fixture.state.pickPartner({ id: 'explicit-interior', type: 'interior_designer', name: 'Chosen existing interior' });
  await fixture.settle(); fixture.fireAutosave(); await fixture.settle();
  const create = fixture.requests.find(request => request.method === 'POST');
  assert.equal(create.url, '/quotations');
  create.resolve({ id: 'created-partner-doc', number: 'TQ-PARTNER' }); await fixture.settle();
  const patch = fixture.requests.find(request => request.method === 'PATCH');
  assert.ok(patch, 'Quotation creation infers customer referral; an explicit document choice requires a follow-up PATCH');
  assert.equal(patch.url, '/quotations/created-partner-doc');
  assert.equal(patch.payload.referrer_id, 'explicit-interior');
  assert.equal(patch.payload.referrer_type, 'interior_designer');
  patch.resolve({ subtotal: 0, grand_total: 0 }); await fixture.settle();
  assert.equal(fixture.state.partner.id, 'explicit-interior');
  assert.equal(fixture.state.partner.type, 'interior_designer');
  const reloaded = builder(); reloaded.render(); reloaded.navigate('created-partner-doc');
  reloaded.requests[0].resolve({ ...restoredDoc('created-partner-doc'), referrer_id: patch.payload.referrer_id,
    referrer_type: patch.payload.referrer_type, referrer_name: 'Chosen existing interior', referrer_company: 'Saved interior studio' });
  await reloaded.settle();
  assert.equal(reloaded.state.partner.id, 'explicit-interior');
  assert.equal(reloaded.state.partner.type, 'interior_designer');
  assert.equal(reloaded.state.partner.company, 'Saved interior studio');
});

for (const fields of [
  { referrer_id: 'archived-reference', referrer_type: 'architect', referrer_name: 'Archived architect', referrer_company: 'Historical studio' },
  { referrer_id: null, referrer_type: null, referrer_name: 'Legacy free text architect', referrer_company: 'Legacy company' },
]) {
  test(`unrelated tile autosave preserves untouched ${fields.referrer_id ? 'archived' : 'legacy free text'} referral`, async () => {
    const fixture = builder(); fixture.render(); fixture.navigate('historical-partner');
    fixture.requests[0].resolve({ ...restoredDoc('historical-partner'), ...fields }); await fixture.settle();
    fixture.state.setHeaderField('address', 'Corrected address only'); await fixture.settle();
    fixture.fireAutosave(); await fixture.settle();
    const patch = fixture.requests.find(request => request.method === 'PATCH');
    assert.equal(patch.url, '/quotations/historical-partner');
    assert.equal(Object.hasOwn(patch.payload, 'referrer_id'), false, 'Unchanged referral must be omitted so archived identities are not revalidated or legacy text cleared');
    assert.equal(Object.hasOwn(patch.payload, 'referrer_type'), false);
    patch.resolve({ subtotal: 0, grand_total: 0 }); await fixture.settle();
    assert.equal(fixture.state.partner?.name || fixture.state.legacyPartnerLabel, fields.referrer_name, 'Unrelated edits retain the historical display label without inventing an identity');
  });
}


test('failed first-create partner patch retries the retained document without another creation', async () => {
  const fixture = builder(); fixture.render();
  fixture.state.pickCustomer({ id: 'customer', name: 'Original customer', phone: '123' });
  fixture.state.setHeaderField('address', 'Partner retry address');
  fixture.state.pickPartner({ id: 'retry-architect', type: 'architect', name: 'Retry architect' });
  await fixture.settle(); fixture.fireAutosave(); await fixture.settle();
  const create = fixture.requests.find(request => request.method === 'POST');
  create.resolve({ id: 'retained-partner-doc', number: 'TQ-RETRY' }); await fixture.settle();
  const failed = fixture.requests.find(request => request.method === 'PATCH');
  assert.ok(failed);
  failed.reject({ detail: 'Synthetic interrupted partner patch' }); await fixture.settle();
  assert.equal(fixture.state.docId, 'retained-partner-doc');
  assert.equal(fixture.state.saveState, 'error');
  assert.equal(fixture.state.partner.id, 'retry-architect');
  const retry = fixture.state.retrySave(); await fixture.settle();
  const patches = fixture.requests.filter(request => request.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.equal(patches[1].url, '/quotations/retained-partner-doc');
  assert.equal(patches[1].payload.referrer_id, 'retry-architect');
  assert.equal(patches[1].payload.referrer_type, 'architect');
  assert.equal(fixture.requests.filter(request => request.method === 'POST').length, 1, 'A persisted document ID must survive the secondary write failure');
  patches[1].resolve({ subtotal: 0, grand_total: 0 }); await retry; await fixture.settle();
  assert.equal(fixture.state.saveState, 'saved');
  assert.equal(fixture.parameterUpdates.at(-1).id, 'retained-partner-doc');
});

test('a newer partner selection during first creation remains dirty and replaces the earlier saved choice', async () => {
  const fixture = builder(); fixture.render();
  fixture.state.pickCustomer({ id: 'customer', name: 'Original customer', phone: '123' });
  fixture.state.setHeaderField('address', 'Partner race address');
  fixture.state.pickPartner({ id: 'old-architect', type: 'architect', name: 'Earlier architect' });
  await fixture.settle(); fixture.fireAutosave(); await fixture.settle();
  const create = fixture.requests.find(request => request.method === 'POST');
  fixture.state.pickPartner({ id: 'new-interior', type: 'interior_designer', name: 'Newer interior' });
  await fixture.settle();
  create.resolve({ id: 'partner-race-doc', number: 'TQ-RACE' }); await fixture.settle();
  const firstPatch = fixture.requests.find(request => request.method === 'PATCH');
  assert.equal(firstPatch.payload.referrer_id, 'old-architect');
  firstPatch.resolve({ subtotal: 0, grand_total: 0 }); await fixture.settle();
  assert.equal(fixture.state.partner.id, 'new-interior', 'Completion must not replace edits typed during the request');
  fixture.fireAutosave(); await fixture.settle();
  const patches = fixture.requests.filter(request => request.method === 'PATCH');
  assert.equal(patches.length, 2, 'The newer partner must schedule another autosave');
  assert.equal(patches[1].url, '/quotations/partner-race-doc');
  assert.equal(patches[1].payload.referrer_id, 'new-interior');
  assert.equal(patches[1].payload.referrer_type, 'interior_designer');
  assert.equal(fixture.requests.filter(request => request.method === 'POST').length, 1);
  patches[1].resolve({ subtotal: 0, grand_total: 0 }); await fixture.settle();
});


test('clearing a legacy name-only reference schedules autosave without any other edit', async () => {
  const fixture = builder(); fixture.render(); fixture.navigate('legacy-clear');
  fixture.requests[0].resolve({ ...restoredDoc('legacy-clear'), referrer_name: 'Legacy architect' }); await fixture.settle();
  fixture.state.pickPartner(null); await fixture.settle(); fixture.fireAutosave(); await fixture.settle();
  const patch = fixture.requests.find(request => request.method === 'PATCH');
  assert.ok(patch); assert.equal(patch.payload.referrer_id, ''); assert.equal(patch.payload.referrer_type, null);
  patch.resolve({}); await fixture.settle();
  assert.equal(fixture.state.legacyPartnerLabel, '');
});
