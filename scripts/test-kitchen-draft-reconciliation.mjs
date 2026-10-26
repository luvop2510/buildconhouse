import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/kitchen/KitchenProjectState.tsx', import.meta.url), 'utf8');
const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
const initial = { id: 'project', workflow_cycle: 1, version: 7, stage: 'lead', lead: { site_location: 'Original' }, visit: { notes: 'Original' }, cad: { progress: 0 }, orders: [] };

async function harness(providerSource = source, record = structuredClone(initial)) {
  const hooks = [], effects = [], writes = [];
  let index = 0, state, settle;
  const same = (first, second) => first && second && first.length === second.length && first.every((value, position) => Object.is(value, second[position]));
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useState(initial) {
      const slot = index++;
      hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, next => { hooks[slot].value = typeof next === 'function' ? next(hooks[slot].value) : next; }];
    },
    useRef(initial) { return hooks[index++] ||= { current: initial }; },
    useCallback(callback, dependencies) {
      const slot = index++;
      if (!same(hooks[slot]?.dependencies, dependencies)) hooks[slot] = { value: callback, dependencies };
      return hooks[slot].value;
    },
    useEffect(callback, dependencies) {
      const slot = index++;
      if (!same(hooks[slot]?.dependencies, dependencies)) { hooks[slot] = { dependencies }; effects.push(callback); }
    },
  };
  const modules = {
    react, 'react/jsx-runtime': { jsx: (_type, props) => ({ props }) },
    'expo-router': { useRouter: () => ({ replace() {} }) },
    '@/src/api/kitchenProjects': { KITCHEN_STAGES: stages, kitchenProjectsApi: {
      get: async () => record, configuration: async () => ({}),
      command: (id, version, key, command, payload) => {
        writes.push({ id, version, key, command, payload });
        return new Promise((resolve, reject) => { settle = value => value instanceof Error ? reject(value) : resolve(value); });
      },
    } },
    './shared': { errorText: String, useKitchenSubmission: () => ({ submit: async (_fingerprint, work, accepted) => {
      try { const value = await work('fixture-request'); accepted(value); return true; } catch { return false; }
    } }) },
    './KitchenDates': { kitchenToday: () => '2026-10-26' },
    './KitchenExitGuard': { useKitchenExitGuard() {} },
  };
  const output = {};
  const compiled = ts.transpileModule(providerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'exports', compiled)(name => { assert.ok(modules[name], name); return modules[name]; }, output);
  function render() {
    index = 0;
    state = output.KitchenProjectProvider({ id: 'project', children: null }).props.value;
    while (effects.length) effects.shift()();
    return state;
  }
  render();
  for (let turn = 0; turn < 12; turn++) { await Promise.resolve(); render(); }
  assert.equal(state.loading, false);
  return { render, get state() { return state; }, writes, settle(value) { settle(value); } };
}

async function checkOrdinary(providerSource = source) {
  for (const [name, key, baseline, first, newer, responseFields] of [
    ['edit_lead', 'lead.value', initial.lead, { site_location: 'Sent' }, { site_location: 'Typed later' }, { lead: { site_location: 'Sent' } }],
    ['save_visit', 'visit.value', initial.visit, { notes: 'Sent' }, { notes: 'Typed later' }, { visit: { notes: 'Sent' } }],
    ['save_cad', 'cad.progress', '0', '10', '20', { cad: { progress: 10 } }],
    ['production_update', 'commercial.cycle.1.production', { status: 'Not Started' }, { status: 'In Progress', notes: 'Sent' }, { status: 'In Progress', notes: 'Typed later' }, { production: { status: 'In Progress', notes: 'Sent' } }],
  ]) {
    const view = await harness(providerSource);
    view.state.setDraftValue(key, baseline, first);
    view.render();
    const pending = view.state.command(name, first, true);
    assert.equal(view.render().backgroundSaving, true);
    const duplicate = await view.state.command(name, first, false);
    assert.equal(duplicate, false, 'A duplicate command cannot enter or reset background feedback');
    assert.equal(view.render().backgroundSaving, true);
    view.state.setDraftValue(key, baseline, newer);
    view.settle({ ...initial, version: 8, ...responseFields });
    assert.equal(await pending, true);
    view.render();
    assert.deepEqual(view.state.drafts[key], newer, `${name}: later typing survives the pending response`);
    assert.equal(view.state.dirty, true, `${name}: later typing must remain unsaved`);
    assert.equal(view.state.backgroundSaving, false);
    assert.equal(view.state.isDraftStale(key), false, `${name}: own acknowledgement rebases persisted source while retaining later edits`);
    const nextSave = view.state.command(name, newer, true);
    assert.equal(view.writes.at(-1).version, 8, 'The following save uses the response version');
    view.settle({ ...initial, version: 9, ...responseFields, ...(name === 'edit_lead' ? { lead: newer } : name === 'save_visit' ? { visit: newer } : name === 'save_cad' ? { cad: { progress: 20 } } : { production: newer }) });
    assert.equal(await nextSave, true);
    assert.equal(view.render().dirty, false, `${name}: only the subsequent response acknowledges the later edit`);
  }
}
await checkOrdinary();
await assert.rejects(checkOrdinary(source.replace('if (unchanged(key)) updated[key] = savedValue;', 'updated[key] = savedValue;')), /later typing survives/, 'Negative control reproduces overwritten typing without snapshot reconciliation');

for (const [name, family, recordKey] of [['order_update', 'order', 'orders'], ['quotation_update', 'quotation', 'quotation_versions'], ['design_update', 'design', 'design_versions']]) {
  const saved = { id: 'selected', notes: 'Original', order_date: '2026-10-20', quotation_version_id: 'q1' };
  const original = { ...initial, stage: family, [recordKey]: [saved] };
  const sourceOf = row => name === 'order_update' ? JSON.stringify([row.order_date, row.notes, row.quotation_version_id]) : JSON.stringify(row);
  const baseline = { source: sourceOf(saved), notes: 'Original', order_date: saved.order_date, ...(name === 'order_update' ? { quotation_version_id: 'q1', amount_customer_approved: 'Not recorded' } : {}) };
  const first = { ...baseline, notes: 'Sent' }, newer = { ...first, notes: 'Typed later', ...(name === 'order_update' ? { quotation_version_id: 'q2', amount_customer_approved: 'Yes' } : {}) };
  const key = `commercial.cycle.1.${family}.selected.edit`;
  const view = await harness(source, original);
  view.state.setDraftValue(key, baseline, first);
  view.render();
  const pending = view.state.command(name, { version_id: 'selected', notes: 'Sent' });
  view.state.setDraftValue(key, baseline, newer);
  const committed = { ...saved, notes: 'Sent' };
  view.settle({ ...original, version: 8, [recordKey]: [committed] });
  await pending;
  view.render();
  assert.deepEqual(view.state.drafts[key], { ...newer, source: sourceOf(committed) }, `${name}: only own source identity is rebased`);
  assert.equal(view.state.dirty, true, `${name}: newer edits remain unsaved`);
  const next = view.state.command(name, { version_id: 'selected', notes: 'Typed later' });
  view.settle({ ...original, version: 9, [recordKey]: [{ ...saved, notes: 'Typed later' }] });
  await next;
  assert.equal(view.render().drafts[key], undefined, `${name}: unchanged acknowledged editor resets to normalized server fields`);
  assert.equal(view.state.dirty, false);
}

async function checkBackgroundAdmission(providerSource = source) {
  for (const name of ['edit_lead','save_visit','save_cad','metadata','order_update']) {
    const view = await harness(providerSource);
    view.state.setDraftValue('lead.value', initial.lead, { site_location: 'Local edit' });
    view.render();
    const captured = view.state.command;
    view.state.updateProject({ ...initial, version: 8, lead: { site_location: 'External correction' } });
    // Intentionally do NOT render: admission must protect the gap before React can update a timer.
    const result = captured(name, { site_location: 'Local edit' }, true);
    assert.equal(view.writes.length, 0, 'An obsolete background callback cannot write with a newer external version');
    assert.equal(await result, false);
    assert.equal(view.render().project.lead.site_location, 'External correction');
    assert.equal(view.state.dirty, true);
  }
}
await checkBackgroundAdmission();
await assert.rejects(checkBackgroundAdmission(source.replace('    if (background && current.version !== project?.version) return Promise.resolve(false);', '')),
  /obsolete background callback/, 'Negative control reproduces the response-before-render overwrite race');

// A callback captured before React renders the latest keystroke still snapshots live drafts.
const synchronous = await harness();
const capturedCommand = synchronous.state.command;
synchronous.state.setDraftValue('lead.value', initial.lead, { site_location: 'Latest keystroke' });
const synchronousSave = capturedCommand('edit_lead', { site_location: 'Latest keystroke' }, true);
synchronous.settle({ ...initial, version: 8, lead: { site_location: 'Latest keystroke' } });
assert.equal(await synchronousSave, true);
assert.equal(synchronous.render().dirty, false);

const obsolete = await harness();
obsolete.state.setDraftValue('lead.value', initial.lead, { site_location: 'Still unsaved' });
obsolete.render();
const obsoleteSave = obsolete.state.command('edit_lead', { site_location: 'Still unsaved' }, true);
obsolete.state.updateProject({ ...initial, version: 10, lead: { site_location: 'Newer server value' } });
obsolete.settle({ ...initial, version: 8, lead: { site_location: 'Still unsaved' } });
assert.equal(await obsoleteSave, false, 'An obsolete response cannot report successful draft acknowledgement');
assert.equal(obsolete.render().dirty, true);
assert.equal(obsolete.state.project.version, 10);

for (const [key, serverField, initialDraft, newerField] of [
  ['lead.value', 'lead', initial.lead, { site_location: 'External correction' }],
  ['visit.value', 'visit', { ...initial.visit, visit_date: '2026-10-26' }, { notes: 'External visit correction' }],
  ['cad.value', 'cad', initial.cad, { progress: 30 }],
  ['cad.progress', 'cad', '0', { progress: 30 }],
  ['plan.target', 'target_completion_date', '', '2026-11-01'],
]) {
  const view = await harness();
  view.state.setDraftValue(key, initialDraft, initialDraft);
  view.render();
  assert.equal(view.state.isDraftStale(key), false, `${key}: UI defaults differ from persisted source without making a new draft stale`);
  view.state.updateProject({ ...initial, version: 8, [serverField]: newerField });
  view.render();
  assert.equal(view.state.isDraftStale(key), true, `${key}: externally changed source blocks automatic overwrite`);
  assert.deepEqual(view.state.drafts[key], initialDraft, `${key}: reload retains the local draft for deliberate reconciliation`);
  view.state.resetDraftValue(key);
  view.render();
  assert.equal(view.state.isDraftStale(key), false, `${key}: explicit replacement clears stale identity`);
  assert.equal(view.state.drafts[key], undefined);
}

async function checkDisplayedDefault(providerSource = source) {
  const view = await harness(providerSource);
  const displayed = { ...initial.visit, visit_date: '2026-10-26' };
  view.state.setDraftValue('visit.value', displayed, displayed);
  view.render();
  assert.equal(view.state.dirty, true, 'Explicitly touching an unsaved displayed default remains dirty');
  assert.equal(view.state.isDraftStale('visit.value'), false, 'A UI default is not an external source change');
  assert.deepEqual(view.state.drafts['visit.value'], displayed, 'The displayed default remains the current input value');
  const pending = view.state.command('save_visit', displayed, true);
  view.settle({ ...initial, version: 8, visit: displayed });
  assert.equal(await pending, true);
  assert.equal(view.render().dirty, false, 'The default becomes saved only after its accepted server response');
}
await checkDisplayedDefault();
await assert.rejects(checkDisplayedDefault(source.replace('baselines.current[key] = source !== undefined ? source : initial;', 'baselines.current[key] = initial;')),
  /Explicitly touching an unsaved displayed default remains dirty/, 'Negative control reproduces falsely Saved UI defaults');

const failure = await harness();
failure.state.setDraftValue('lead.value', initial.lead, { site_location: 'Keep me' });
failure.render();
const failed = failure.state.command('edit_lead', { site_location: 'Keep me' }, true);
failure.settle(new Error('Offline'));
assert.equal(await failed, false);
assert.equal(failure.render().dirty, true, 'A failed save never acknowledges the draft');
assert.equal(failure.state.backgroundSaving, false);

const revision = await harness();
const designKey = 'commercial.cycle.1.design.selected.edit';
revision.state.setDraftValue(designKey, { notes: 'Original' }, { notes: 'Unsaved correction' });
revision.render();
const request = revision.state.command('design_revision', { version_id: 'selected', reason: 'Revision request only' });
revision.settle({ ...initial, version: 8, design_revision_pending: true });
await request;
assert.equal(revision.render().dirty, true, 'A revision reason cannot acknowledge an unrelated internal-note correction');
console.log('Kitchen provider draft reconciliation: pending typing, request baselines, own-source rebase, duplicate admission, failure and revision isolation passed');
