import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/quotation/helpers/draftStorage.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const prefix = 'forge.builder.draft.v1';
const marker = 'forge.builder.customerResetEpoch.v1';
const release = 'customer-reset-20261010';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(seed = {}) {
  const data = new Map(Object.entries(seed));
  const removed = [];
  let failKey, enumerationFails = false, beforeWrite;
  const storage = {
    getItem: async (key, fallback) => data.has(key) ? data.get(key) : fallback,
    setItem: async (key, value) => { if (beforeWrite) await beforeWrite.promise; data.set(key, value); return true; },
    removeItem: async key => { removed.push(key); if (key === failKey) return false; data.delete(key); return true; },
  };
  const modules = {
    '@react-native-async-storage/async-storage': { default: { getAllKeys: async () => {
      if (enumerationFails) throw new Error('Fixture storage unavailable');
      return [...data.keys()];
    } } },
    '@/src/utils/storage': { storage },
    './draftRecovery': { parseBuilderDraft: raw => raw ? JSON.parse(raw) : null },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(modules[name], `Unexpected import: ${name}`); return modules[name]; } });
  return { api: exports, data, removed, fail: key => { failKey = key; }, failEnumeration: value => { enumerationFails = value; }, blockWrite: gate => { beforeWrite = gate; } };
}

test('reset removes indexed and orphan customer draft blobs and legacy snapshot while preserving preferences', async () => {
  const f = fixture({
    [`${prefix}.keys`]: JSON.stringify([`${prefix}.owner.first-floor`]),
    [`${prefix}.owner.first-floor`]: 'Sensitive customer phone',
    [`${prefix}.other.ground-floor`]: 'Orphan customer address',
    'forge.builder.snapshot.v4': 'Historical customer draft',
    'forge.favourites.v1': 'product-favourite',
    'forge.admin.sidebar.collapsed.v1': true,
    'forge.jwt.kind': 'staff',
  });
  await f.api.ensureBuilderDraftReset();
  assert.equal([...f.data.keys()].some(key => key.startsWith(`${prefix}.`)), false);
  assert.equal(f.data.has('forge.builder.snapshot.v4'), false);
  assert.equal(f.data.get('forge.favourites.v1'), 'product-favourite');
  assert.equal(f.data.get('forge.admin.sidebar.collapsed.v1'), true);
  assert.equal(f.data.get('forge.jwt.kind'), 'staff');
  assert.equal(f.data.get(marker), release);
});

test('reset is serialized and post-reset drafts survive subsequent startup modules', async () => {
  const f = fixture({ [`${prefix}.owner.first-floor`]: 'Previous draft' });
  const first = f.api.ensureBuilderDraftReset();
  assert.equal(f.api.ensureBuilderDraftReset(), first);
  await first;
  f.data.set(`${prefix}.owner.first-floor`, 'New customer draft');
  const nextStartup = fixture(Object.fromEntries(f.data));
  await nextStartup.api.ensureBuilderDraftReset();
  assert.equal(nextStartup.data.get(`${prefix}.owner.first-floor`), 'New customer draft');
  assert.equal(nextStartup.removed.length, 0);
});

test('failed deletion does not mark reset complete and retries remaining blobs', async () => {
  const key = `${prefix}.owner.first-floor`;
  const f = fixture({ [key]: 'Sensitive customer' });
  f.fail(key);
  await assert.rejects(f.api.ensureBuilderDraftReset(), /Could not clear previous quotation drafts/);
  assert.equal(f.data.has(marker), false);
  assert.equal(f.data.has(key), true);
  f.fail(undefined);
  await f.api.ensureBuilderDraftReset();
  assert.equal(f.data.has(key), false);
  assert.equal(f.data.get(marker), release);
});

test('unavailable key enumeration keeps reset incomplete and can recover', async () => {
  const key = `${prefix}.orphan.first-floor`;
  const f = fixture({ [key]: 'Sensitive customer' });
  f.failEnumeration(true);
  await assert.rejects(f.api.ensureBuilderDraftReset(), /Fixture storage unavailable/);
  assert.equal(f.data.has(marker), false);
  assert.equal(f.data.has(key), true);
  f.failEnumeration(false);
  await f.api.ensureBuilderDraftReset();
  assert.equal(f.data.has(key), false);
});

test('startup reset invalidates previously queued draft writers and deletes an in-flight persisted blob', async () => {
  const f = fixture();
  const gate = deferred();
  f.blockWrite(gate);
  const oldEpoch = f.api.builderDraftEpoch();
  const draft = { accountId: 'owner', floorId: 'first-floor', state: { header: { phone: 'Sensitive phone' } } };
  const delayedWrite = f.api.writeBuilderDraft(draft, oldEpoch);
  // Let the indexed write begin and block; startup must await it before deletion.
  await Promise.resolve(); await Promise.resolve();
  const reset = f.api.ensureBuilderDraftReset();
  await Promise.resolve(); await Promise.resolve();
  gate.resolve();
  await Promise.all([delayedWrite, reset]);
  await f.api.writeBuilderDraft(draft, oldEpoch);
  assert.equal([...f.data.keys()].some(key => key.startsWith(`${prefix}.`)), false);
  assert.equal(f.data.get(marker), release);
});
