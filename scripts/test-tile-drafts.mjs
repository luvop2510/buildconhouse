import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const data = new Map();
let epoch = 3;
const registered = [];
const compiled = ts.transpileModule(readFileSync(new URL('../src/components/tiles/tileDraftStorage.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports, require: name => ({
  '@/src/utils/storage': { storage: { getItem: async (key, fallback) => data.get(key) || fallback } },
  '@/src/components/quotation/helpers/draftRecovery': { DRAFT_TTL_MS: 7 * 86400000 },
  '@/src/components/quotation/helpers/draftStorage': {
    writeRegisteredBuilderDraft: async (key, draft, expected) => { registered.push(key); if (epoch === expected) data.set(key, JSON.stringify(draft)); },
    removeRegisteredBuilderDraft: async key => { data.delete(key); },
  },
})[name] });
const now = Date.now();
const draft = {
  version: 1, accountId: 'owner', docType: 'tiles_selection', routeId: null, at: now,
  documentId: null, number: null, serverSavedAt: null, clientDraftId: '11111111-1111-4111-8111-111111111111',
  customerId: null, customerSnapshot: { name: '', phone: '' },
  header: Object.fromEntries(['customerName', 'phone', 'reference', 'docDate', 'attendedBy', 'preparedBy', 'address', 'docNumber', 'transportationFee'].map(key => [key, ''])),
  rows: [{ key: 'row', productId: 'tile', image: 'https://example.test/photo.jpg', name: 'Tile', sku: 'SKU', area: '', size: '', rateSqft: '', boxSqft: '', offerRate: '', rateBox: '', totalBox: '', pcsBox: '', total: '', quantityUnit: 'Box' }],
  partner: null, legacyPartnerLabel: '', partnerEdited: false,
};
const parse = value => exports.parseTileDraft(JSON.stringify(value), 'owner', 'tiles_selection', null, now);

test('partial tile draft keeps blank fields and quantity together with its saved product photo', () => {
  const restored = parse(draft);
  assert.equal(restored.rows[0].totalBox, ''); assert.equal(restored.rows[0].image, draft.rows[0].image);
});

test('tile draft recovery rejects account/type/document mismatches, stale data and malformed rows', () => {
  for (const patch of [{ accountId: 'other' }, { docType: 'tiles_quotation' }, { routeId: 'other' }, { at: now - 8 * 86400000 }, { at: now + 120000 }, { rows: [] }, { rows: [draft.rows[0], draft.rows[0]] }, { clientDraftId: 'invalid' }, { header: {} }, { partner: { id: 'x', name: 'X', type: 'invalid' } }]) assert.equal(parse({ ...draft, ...patch }), null);
});

test('tiles use the shared customer-draft registry, revocation epoch and independent type scopes', async () => {
  await exports.writeTileDraft(draft, 3);
  assert.equal(registered.at(-1).startsWith('forge.builder.draft.v1.'), true);
  assert.equal((await exports.readTileDraft('owner', 'tiles_selection', null)).rows[0].image, draft.rows[0].image);
  assert.equal(await exports.readTileDraft('other', 'tiles_selection', null), null);
  assert.equal(await exports.readTileDraft('owner', 'tiles_quotation', null), null);
  epoch = 4;
  await exports.writeTileDraft({ ...draft, header: { ...draft.header, address: 'Delayed stale write' } }, 3);
  assert.equal((await exports.readTileDraft('owner', 'tiles_selection', null)).header.address, '');
  await exports.removeTileDraft('owner', 'tiles_selection', null);
  assert.equal(await exports.readTileDraft('owner', 'tiles_selection', null), null);
});

test('automatic recovery requires exact base revision and refuses already ordered records', () => {
  const saved = { ...draft, documentId: 'doc', serverSavedAt: 'v1' };
  assert.equal(exports.tileDraftMatchesServer(saved, { id: 'doc', updated_at: 'v1', status: 'draft' }), true);
  for (const server of [{ id: 'doc', updated_at: 'v2' }, { id: 'other', updated_at: 'v1' }, { id: 'doc', updated_at: 'v1', status: 'ordered' }]) assert.equal(exports.tileDraftMatchesServer(saved, server), false);
});
