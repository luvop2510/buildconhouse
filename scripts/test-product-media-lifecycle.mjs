import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/catalog/ProductImageManager.tsx', import.meta.url), 'utf8')
  .replace('  return (\n    <>', '  return { media, pending, busy, confirmDeleteId, pick, confirmUpload, setPrimary, doDelete, setConfirmDeleteId };\n  return (\n    <>');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const hooks = [], effects = [], uploads = [], writes = [], picks = [], changed = [];
  let index = 0, current, productId = 'old-product';
  const same = (left, right) => left && right && left.length === right.length && left.every((v, i) => Object.is(v, right[i]));
  const react = {
    useState(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      return [hooks[slot], value => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value; }]; },
    useRef(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useCallback(callback, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { deps, callback }; return hooks[slot].callback; },
    useEffect(effect, deps) { const slot = index++; if (!same(hooks[slot]?.deps, deps)) { const previous = hooks[slot];
      hooks[slot] = { deps }; effects.push(() => { previous?.cleanup?.(); hooks[slot].cleanup = effect(); }); } },
  };
  const api = { get: async () => [], upload: (_path, _form, options) => { const pending = deferred(); uploads.push({ ...pending, options }); return pending.promise; },
    patch: (_path, _body, options) => { const pending = deferred(); writes.push({ ...pending, options }); return pending.promise; },
    delete: (_path, options) => { const pending = deferred(); writes.push({ ...pending, options }); return pending.promise; } };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, AbortController, FormData,
    require: name => name === 'react' ? react : name === 'react-native' ? { StyleSheet: { create: value => value, hairlineWidth: 1 } } :
      name === 'expo-image-picker' ? { launchImageLibraryAsync: () => { const pending = deferred(); picks.push(pending); return pending.promise; } } :
      name.endsWith('/client') ? { api } : name.endsWith('/appendImageUpload') ? { appendImageUpload: async () => {} } :
      name.endsWith('/responsive') ? { useBp: () => ({ isPhone: true }) } : name.endsWith('/Toast') ? { toast: { success: () => {}, error: () => {} } } :
      name.endsWith('/tokens') ? { colors: {}, radius: {}, spacing: {}, type: {} } : {},
  });
  const render = () => { index = 0; current = module.exports.ProductImageManagerBody({ productId, onChanged: () => changed.push(productId) });
    while (effects.length) effects.shift()(); return current; };
  const settle = async () => { await new Promise(done => setImmediate(done)); return render(); };
  render();
  return { uploads, writes, picks, changed, render, settle, switchTo(id) { productId = id; render(); }, get state() { return current; } };
}
const picked = { canceled: false, assets: [{ uri: 'blob:photo', mimeType: 'image/png' }] };
{
  const f = fixture(); await f.settle();
  f.state.setConfirmDeleteId('old-product-media'); await f.settle();
  f.switchTo('new-product'); await f.settle();
  assert.equal(f.state.confirmDeleteId, null, 'switching product must close the previous image deletion prompt');
  await f.state.doDelete();
  assert.equal(f.writes.length, 0, 'the new product cannot confirm an old product image deletion');
}
{
  const f = fixture(); await f.settle();
  const selecting = f.state.pick(); f.switchTo('new-product'); f.picks[0].resolve(picked); await selecting; await f.settle();
  assert.equal(f.state.pending, null, 'late system picker must not attach old product photo to new product');
}
{
  const f = fixture(); await f.settle();
  const selecting = f.state.pick(); f.picks[0].resolve(picked); await selecting; await f.settle();
  const uploading = f.state.confirmUpload(); await f.settle();
  assert.equal(f.state.busy, true);
  f.switchTo('new-product'); await f.settle();
  assert.equal(f.uploads[0].options.signal.aborted, true);
  assert.equal(f.state.busy, false, 'product switch releases old upload busy state');
  f.uploads[0].resolve({ id: 'old-media' }); await uploading; await f.settle();
  assert.equal(f.state.pending, null); assert.equal(f.changed.length, 0);
  const selectingAgain = f.state.pick(); f.picks[1].resolve(picked); await selectingAgain; await f.settle();
  const saving = f.state.confirmUpload(); await f.settle(); f.uploads[1].resolve({ id: 'new-media' }); await saving; await f.settle();
  assert.equal(f.state.busy, false); assert.deepEqual(f.changed, ['new-product']);
}
for (const action of ['primary', 'delete']) {
  const f = fixture(); await f.settle();
  if (action === 'delete') { f.state.setConfirmDeleteId('old-media'); f.render(); }
  const pending = action === 'primary' ? f.state.setPrimary('old-media') : f.state.doDelete();
  await f.settle(); f.switchTo('new-product'); await f.settle();
  assert.equal(f.writes[0].options.signal.aborted, true);
  f.writes[0].resolve({ ok: true }); await pending; await f.settle();
  assert.equal(f.changed.length, 0, `${action}: stale mutation cannot publish into new product`);
  assert.equal(f.state.busy, false);
}
console.log('Actual product image manager picker/upload/delete/primary scope races and busy-state recovery passed.');
