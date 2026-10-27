import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const calls = [], exports = {};
const api = new Proxy({}, { get: (_, method) => (...args) => { calls.push({ method, args }); return Promise.resolve({}); } });
const source = readFileSync(new URL('../src/api/tileOrders.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, require: name => name.endsWith('floors') ? { TILES_FLOOR_ID: 'ground-floor' } : { api } });
for (const name of ['listCustomerOrders', 'listBrands', 'listHistory', 'listInventory', 'listMovements', 'listDispatchList']) {
  const controller = new AbortController();
  await exports.tileOrdersApi[name]({ page: 2, search: 'literal + tile' }, controller.signal);
  const { method, args: [path, options] } = calls.at(-1);
  assert.equal(method, 'get'); assert.equal(options.floorId, 'ground-floor'); assert.equal(options.signal, controller.signal);
  assert.equal(new URL(path, 'https://fixture.test').searchParams.get('search'), 'literal + tile');
  controller.abort(); assert.equal(options.signal.aborted, true);
}
await exports.tileOrdersApi.markDelivered('dispatch', { received_by: 'Fixture' });
assert.equal(calls.at(-1).args[2].signal, undefined, 'List cancellation must never affect a business write');
console.log('All six Tile Orders list reads retain exact floor/query and consumer cancellation; writes are unchanged.');
