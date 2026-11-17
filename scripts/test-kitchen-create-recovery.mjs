import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const body = { idempotency_key: 'lead-operation', customer: { name: 'Separate lead', phone: '9001112223', address: 'Test address' }, lead: { status: 'New' } };
const project = { id: 'saved-project', stage: 'lead', version: 1 };
for (const scenario of ['success', 'lost-saved', 'lost-absent', 'lost-read-fails', 'lost-read-stalls', 'denied', 'aborted', 'retry-saved', 'retry-absent', 'retry-read-fails']) {
  const calls = [], timers = new Map();
  const failure = Object.assign(new Error('Original create response lost'), scenario === 'aborted' ? { name: 'AbortError' } : { status: scenario === 'denied' ? 403 : 503 });
  const output = { exports: {} };
  vm.runInNewContext(ts.transpileModule(readFileSync('src/api/kitchenProjects.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module: output, exports: output.exports, AbortController, DOMException,
    setTimeout: (callback, ms) => { timers.set(callback, ms); return callback; }, clearTimeout: callback => timers.delete(callback),
    require: name => name.endsWith('client') ? { api: {
      post: async (path, sent, options) => { calls.push(['post', path]); assert.equal(sent, body); assert.equal(options.floorId, 'second-floor'); if (['success', 'retry-absent'].includes(scenario)) return project; throw failure; },
      get: async (path, options) => {
        calls.push(['get', path]); assert.equal(path, '/kitchen-projects/creation-status?key=lead-operation'); assert.equal(options.cacheMs, 0); assert.equal(options.floorId, 'second-floor');
        if (scenario.includes('read-fails')) throw Error('Status unavailable');
        if (scenario === 'lost-read-stalls') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        return { project: scenario.endsWith('saved') ? project : null };
      },
    } } : name.endsWith('floors') ? { KITCHEN_FLOOR_ID: 'second-floor' } : { KITCHEN_WORKSPACE_PAGES: [], KITCHEN_VISIBLE_PAGES: [] },
  });
  const result = output.exports.kitchenProjectsApi.create(body, scenario.startsWith('retry'))
    .then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  if (scenario === 'lost-read-stalls') { assert.equal([...timers.values()][0], 3000); [...timers.keys()][0](); }
  const outcome = await result;
  assert.equal(calls.filter(call => call[0] === 'post').length, ['retry-saved', 'retry-read-fails'].includes(scenario) ? 0 : 1, 'No automatic write replay and status failures cannot admit a retry');
  if (['success', 'lost-saved', 'retry-saved', 'retry-absent'].includes(scenario)) assert.equal(outcome.value, project);
  else if (scenario !== 'retry-read-fails') assert.equal(outcome.error, failure, 'Preserve the original uncertain response error');
  if (['denied', 'aborted'].includes(scenario)) assert.equal(calls.length, 1, 'Authorization and context aborts cannot trigger reconciliation reads');
  if (scenario.startsWith('retry')) assert.equal(calls[0][0], 'get', 'An explicit retry checks committed state before sending its original key');
  assert.equal(timers.size, 0, 'Every status read releases its deadline');
}
console.log('Kitchen create response recovery: exact operation lookup, explicit retry preflight, unchanged keys, bounded reads, original errors, authorization/context guards and no automatic write replay passed.');
