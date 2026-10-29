import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { filterValues } from '../src/utils/filters.ts';

const requests = [];
const downloads = [];
let generation = 0;
const controllers = [];
const beginIdentityOperation = () => {
 const version = generation, controller = new AbortController(); controllers.push(controller);
 return { signal: controller.signal, isCurrent: () => !controller.signal.aborted && version === generation, finish() {} };
};
let holdBody = null;
const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL('../src/utils/sectionExcel.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
runInNewContext(code, {
  module, exports: module.exports, AbortController,
  require: name => name === 'react-native' ? { Platform: { OS: 'web' } }
    : name === './filters' ? { filterValues }
      : name === './downloadFile' ? { savePreparedFile: async (_blob, filename, _label, operation) => { assert(operation.isCurrent()); downloads.push(filename); return true; } }
      : { api: { base: '' }, beginIdentityOperation, csrfHeaders: () => ({ 'X-CSRF-Token': 'fixture-csrf' }), getToken: async () => null },
  fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, blob: async () => holdBody || new Blob(['fixture']) }; },
  URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => {} },
  document: { createElement: () => { const anchor = { click: () => downloads.push(anchor.download), remove: () => {} }; return anchor; }, body: { appendChild: () => {} } },
  window: { setTimeout: () => 0 },
});
const options = { page: 'Sales', section: 'Filtered revenue', resource: 'sales_data', rows: [['Customer', 'Revenue'], ['Fixture', 200]], filename: 'revenue.xlsx' };
for (const floorId of ['first-floor', 'first-floor,second-floor', 'all', 'both']) await module.exports.downloadSectionExcel({ ...options, floorId });
assert.equal(requests[0].headers['X-Floor-Id'], 'first-floor');
for (const request of requests.slice(1)) assert.equal(request.headers['X-Floor-Id'], undefined);
assert.ok(requests.every(request => request.headers['X-CSRF-Token'] === 'fixture-csrf'));
assert.ok(requests.every(request => JSON.parse(request.body).sections[0].rows[1][1] === '200'));
assert.deepEqual(downloads, ['revenue.xlsx', 'revenue.xlsx', 'revenue.xlsx', 'revenue.xlsx']);
let release;
holdBody = new Promise(resolve => { release = resolve; });
const pending = module.exports.downloadSectionExcel({ ...options, floorId: 'first-floor' });
await new Promise(resolve => setImmediate(resolve));
generation++; controllers.forEach(controller => controller.abort());
release(new Blob(['dummy old-account rows']));
await pending;
assert.equal(downloads.length, 4, 'old-account rows never reach the prepared-file publisher');
assert.equal(requests.at(-1).signal.aborted, true);
console.log('Section Excel: combined/all floor filters omit invalid workspace headers and preserve exported rows');
