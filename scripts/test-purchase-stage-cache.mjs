import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const engine = readFileSync(new URL('../src/components/purchases/MovementEngine.tsx', import.meta.url), 'utf8');
const stageFunction = engine.slice(engine.indexOf('export async function fetchStages'), engine.indexOf('export function fmtDateTime'));

for (const platform of ['client.ts', 'client.web.ts']) {
  let floor = 'first-floor';
  let calls = 0;
  const storage = { secureGet: async () => null, getItem: async () => floor,
    secureSet: async () => {}, setItem: async () => {}, secureRemove: async () => {}, removeItem: async () => {} };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/api/${platform}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
    __DEV__: true, process: { env: {} }, document: { cookie: '' },
    AbortController, DOMException, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify([{ key: 'in_box', count: ++calls, floor }]) }),
  });
  const client = module.exports;
  client.setRequestFloorId(floor);
  const stages = {};
  vm.runInNewContext(ts.transpileModule(stageFunction, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: stages, api: client.api });
  assert.equal((await stages.fetchStages())[0].count, 1);
  assert.equal((await stages.fetchStages())[0].count, 1, 'repeat read uses bounded API cache');
  floor = 'ground-floor';
  client.setRequestFloorId(floor);
  assert.equal((await stages.fetchStages())[0].floor, floor);
  assert.equal(calls, 2, 'floor switch fetches its own counts');
  client.clearApiResponseCache();
  assert.equal((await stages.fetchStages())[0].count, 3, 'movement invalidation refreshes counts');
  assert.equal((await stages.fetchStages(true))[0].count, 4, 'explicit refresh stays fresh');
  client.invalidateApiRequests('identity');
  assert.equal((await stages.fetchStages())[0].count, 5, 'a new account cannot inherit counts');
  console.log(`${platform}: stage counts reuse scoped cache and refresh after floor/account/mutation changes.`);
}
