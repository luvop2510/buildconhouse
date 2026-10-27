import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

for (const name of ['client.ts', 'client.web.ts']) {
  const requests = [];
  const module = { exports: {} };
  const storage = { secureGet: async () => null, getItem: async () => 'ground-floor', secureSet: async () => {}, setItem: async () => {}, secureRemove: async () => {}, removeItem: async () => {} };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/api/${name}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, require: () => ({ storage, browserStorage: storage }),
    __DEV__: true, process: { env: {} }, document: { cookie: '' }, AbortController, DOMException, setTimeout, clearTimeout,
    fetch: (_url, { signal, method }) => new Promise((resolve, reject) => {
      const row = { signal, method, finish: () => resolve({ ok: true, text: async () => '{"saved":true}' }) };
      requests.push(row);
      const abort = () => reject(new DOMException('canceled', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });
  const { api, setRequestFloorId } = module.exports;
  setRequestFloorId('ground-floor');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 8; index++) {
    const controller = new AbortController();
    const pending = api.get(`/search?q=${index}`, { signal: controller.signal }).catch(error => error);
    await tick();
    controller.abort();
    assert.equal((await pending).name, 'AbortError');
  }
  await tick();
  assert.equal(requests.length, 8);
  assert.equal(requests.filter(row => !row.signal.aborted).length, 0, `${name}: obsolete searches release every transport`);

  for (const unsignaled of [false, true]) {
    const first = new AbortController(), second = new AbortController();
    const a = api.get('/shared', { signal: first.signal }).catch(error => error);
    const b = api.get('/shared', unsignaled ? undefined : { signal: second.signal });
    await tick();
    const row = requests.at(-1);
    first.abort();
    assert.equal((await a).name, 'AbortError');
    assert.equal(row.signal.aborted, false, 'A remaining consumer owns the shared read');
    row.finish();
    assert.equal((await b).saved, true);
    assert.equal(row.signal.aborted, false, 'Successful settlement does not abort its transport');
  }
  const before = requests.length;
  const old = new AbortController();
  const abandoned = api.get('/same-query', { signal: old.signal }).catch(error => error);
  await tick(); old.abort(); await abandoned;
  const replacement = api.get('/same-query');
  await tick();
  assert.equal(requests.length, before + 2, 'New consumers never join an abandoned transport');
  requests.at(-1).finish(); await replacement;

  const canceled = new AbortController(); canceled.abort();
  const count = requests.length;
  await assert.rejects(api.get('/never-start', { signal: canceled.signal }), { name: 'AbortError' });
  assert.equal(requests.length, count);
  const write = api.post('/synthetic-save', { value: 1 });
  await tick(); requests.at(-1).finish(); await write;
  assert.equal(requests.filter(row => row.method === 'POST').length, 1, 'Mutations are never replayed');
  console.log(`${name}: 8/8 obsolete transports canceled; shared/unsignaled consumers, replacement and single-write checks passed.`);
}
