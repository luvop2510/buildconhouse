import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const visit = { status: 'Visited', visit_date: '2026-10-27', display_model: 'GI', notes: 'Saved visit' };
for (const scenario of ['saved', 'saved-whitespace', 'saved-empty', 'saved-408', 'saved-502', 'saved-504', 'different-notes', 'different-status', 'different-date', 'different-model', 'unchanged-version', 'other-project', 'other-stage', 'unknown-field', 'missing-visit', 'read-fails', 'read-stalls', 'denied', 'payment']) {
  let writes = 0, reads = 0;
  const timers = [];
  const failure = Object.assign(new Error('Lost visit response'), { status: scenario === 'denied' ? 403 : /^saved-(408|502|504)$/.test(scenario) ? Number(scenario.slice(6)) : 503 });
  const saved = { id: scenario === 'other-project' ? 'other' : 'project', version: scenario === 'unchanged-version' ? 1 : 2, stage: scenario === 'other-stage' ? 'cad' : 'visit', visit: { ...visit } };
  for (const [name, key] of [['different-notes', 'notes'], ['different-status', 'status'], ['different-date', 'visit_date'], ['different-model', 'display_model']]) if (scenario === name) saved.visit[key] = 'different';
  if (scenario === 'missing-visit') saved.visit = null;
  const payload = scenario === 'unknown-field' ? { ...visit, requirements: 'Additional field not covered by confirmation' }
    : scenario === 'saved-whitespace' ? { ...visit, display_model: ' GI ', notes: '  Saved visit \n' }
    : scenario === 'saved-empty' ? { ...visit, display_model: '  ', notes: ' \t' } : visit;
  if (scenario === 'saved-empty') saved.visit = { ...visit, display_model: '', notes: '' };
  const module = { exports: {} };
  const api = {
    post: async () => { writes++; throw failure; },
    get: async (_path, options) => {
      reads++; assert.equal(options.floorId, 'second-floor'); assert.equal(options.cacheMs, 0);
      if (scenario === 'read-fails') throw Error('Read failed');
      if (scenario === 'read-stalls') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      return saved;
    },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync('src/api/kitchenProjects.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, AbortController, DOMException,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return callback; },
    clearTimeout: callback => { const index = timers.findIndex(timer => timer.callback === callback); if (index >= 0) timers.splice(index, 1); },
    require: name => name.endsWith('client') ? { api } : name.endsWith('floors') ? { KITCHEN_FLOOR_ID: 'second-floor' } : { KITCHEN_WORKSPACE_PAGES: [] },
  });
  const result = module.exports.kitchenProjectsApi.command('project', 1, 'visit-receipt', scenario === 'payment' ? 'order_advance' : 'save_visit', payload)
    .then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  if (scenario === 'read-stalls') { assert.equal(timers[0].ms, 3000); timers[0].callback(); }
  const outcome = await result;
  assert.equal(writes, 1, 'Reconfirmation must never replay a POST');
  assert.equal(reads, ['denied', 'payment'].includes(scenario) ? 0 : 1);
  if (scenario.startsWith('saved')) assert.equal(outcome.value, saved);
  else assert.equal(outcome.error, failure);
  assert.equal(timers.length, 0);
}
console.log('Kitchen Visit response confirmation: exact saved snapshot and newer version recover; mismatches, stale/offline/auth/financial commands retain original error and receipt without replay.');
