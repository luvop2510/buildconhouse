import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/kitchen/KitchenProjectState.tsx', import.meta.url), 'utf8');
const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
const initial = { id: 'project', workflow_cycle: 1, version: 7, stage: 'lead', lead: { site_location: 'Original' }, visit: { notes: 'Original' }, cad: { progress: 0 }, orders: [] };

async function harness(providerSource = source, record = structuredClone(initial), executeCommand) {
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
        if (executeCommand) return executeCommand(id, version, key, command, payload);
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
  return { render, get state() { return state; }, writes, returnPath: output.kitchenReturnPath, settle(value) { settle(value); } };
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
  const sourceOf = row => name === 'order_update' ? JSON.stringify([row.order_date, row.notes, row.quotation_version_id]) : name === 'design_update' ? JSON.stringify([row, null]) : JSON.stringify(row);
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
assert.equal(failure.returnPath('/kitchen'), '/kitchen', 'A customer opened from universal search returns to its dashboard');
assert.equal(failure.returnPath('/kitchen/stages/visit?search=Customer&view=list&page=2'), '/kitchen/stages/visit?search=Customer&view=list&page=2');
for (const unsafe of ['https://example.com', '//example.com', '/kitchen-other', '/customers', '/kitchen/unknown']) {
  assert.equal(failure.returnPath(unsafe), '/kitchen/stages/lead', 'Untrusted return paths retain their safe fallback');
}
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


// Execute the actual API confirmation path through the actual mounted provider.
const visitApiSource = await readFile(new URL('../src/api/kitchenProjects.ts', import.meta.url), 'utf8');
assert.ok(visitApiSource.includes('["move_stage", "save_visit"]'));
for (const confirm of [false, true]) for (const background of [false, true]) for (const newerTyping of [false, true]) {
  const original = { ...initial, stage: 'visit', visit: { status: 'Scheduled', visit_date: '2026-10-27', display_model: null, notes: null } };
  const submitted = { ...original.visit, notes: 'Submitted visit' };
  let persisted = structuredClone(original), releaseRead;
  const confirmedRead = new Promise(resolve => { releaseRead = resolve; });
  const transport = {
    post: async (_path, body) => {
      if (body.expected_version !== persisted.version) throw Object.assign(Error('Stale version'), { status: 409 });
      if (body.command === 'save_visit') {
        persisted = { ...persisted, version: persisted.version + 1, visit: { ...persisted.visit, ...body.payload } };
        throw Object.assign(Error('Cannot reach the backend'), { status: 503 });
      }
      assert.equal(body.command, 'move_stage');
      persisted = { ...persisted, version: persisted.version + 1, stage: body.payload.target_stage };
      return persisted;
    },
    get: async () => { await confirmedRead; return persisted; },
  };
  const apiExports = {};
  new Function('require', 'exports', ts.transpileModule(confirm ? visitApiSource : visitApiSource.replace('["move_stage", "save_visit"]', '["move_stage"]'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(name => name.endsWith('client') ? { api: transport } : name.endsWith('floors') ? { KITCHEN_FLOOR_ID: 'second-floor' } : { KITCHEN_WORKSPACE_PAGES: [] }, apiExports);
  const view = await harness(source, original, apiExports.kitchenProjectsApi.command);
  view.state.setDraftValue('visit.value', original.visit, submitted);
  view.render();
  const saving = view.state.command('save_visit', submitted, background);
  await Promise.resolve(); await Promise.resolve();
  if (newerTyping) view.state.setDraftValue('visit.value', original.visit, { ...submitted, notes: 'Typed while confirming' });
  releaseRead();
  if (!confirm) {
    assert.equal(await saving, false, 'Negative control reproduces the lost Visit acknowledgement');
    assert.equal(await view.state.command('move_stage', { target_stage: 'cad' }), false, 'Negative control reproduces Next CAD failing on the stale version');
    assert.equal(view.writes[1].version, original.version);
    assert.equal(view.render().project.stage, 'visit');
    assert.equal(persisted.version, original.version + 1);
    assert.equal(view.state.dirty, true);
    continue;
  }
  assert.equal(await saving, true, 'A lost committed Visit response is confirmed without another save');
  assert.equal(view.render().project.version, original.version + 1);
  assert.equal(view.state.drafts['visit.value'].notes, newerTyping ? 'Typed while confirming' : 'Submitted visit');
  assert.equal(view.state.dirty, newerTyping, 'Confirmation acknowledges only the submitted snapshot');
  assert.equal(view.state.isDraftStale('visit.value'), false);
  assert.equal(await view.state.command('move_stage', { target_stage: 'cad' }), true);
  assert.deepEqual(view.writes.map(write => write.command), newerTyping ? ['save_visit', 'save_visit', 'move_stage'] : ['save_visit', 'move_stage'], 'Only newer unsaved typing adds a fresh save before Next; confirmation never replays the old POST');
  assert.equal(view.writes.at(-1).version, original.version + (newerTyping ? 2 : 1), 'Next CAD uses the latest acknowledged version');
  assert.equal(persisted.visit.notes, newerTyping ? 'Typed while confirming' : 'Submitted visit');
  assert.equal(view.render().project.stage, 'cad');
}
console.log('Actual Kitchen provider and API: manual/autosave lost Visit acknowledgements confirm once, retain newer typing and let Next CAD use the current version.');

for (const [stage, field, changed] of [['lead', 'lead', { notes: 'Immediate lead notes', lead_date: '2026-10-29' }], ['visit', 'visit', { notes: 'Immediate next visit' }], ['cad', 'cad', { notes: 'Immediate next CAD' }]]) {
  const original = { ...initial, stage, lead: { status: 'New' }, visit: { status: 'Scheduled', notes: 'Original' }, cad: { received: false, progress: 0, status: 'Not Started', ready: false, notes: 'Original' } };
  let persisted = structuredClone(original);
  const view = await harness(source, original, async (_id, version, _key, name, payload) => {
    assert.equal(version, persisted.version);
    persisted = { ...persisted, version: persisted.version + 1, ...(name === 'move_stage' ? { stage: payload.target_stage } : { [field]: { ...persisted[field], ...payload } }) };
    return persisted;
  });
  view.state.setDraftValue(`${stage}.value`, original[field], { ...original[field], ...changed });
  view.render();
  assert.equal(await view.state.command('move_stage', { target_stage: stages[stages.indexOf(stage) + 1] }), true);
  assert.deepEqual(view.writes.map(write => write.command), [stage === 'lead' ? 'edit_lead' : `save_${stage}`, 'move_stage'], 'Immediate Next saves routine entries even before debounce');
  assert.equal(view.writes[1].version, original.version + 1);
  assert.deepEqual(persisted[field], { ...original[field], ...changed });
  assert.equal(view.render().dirty, false);
}
for (const [stage, changed, progress] of [['lead', { status: 'Lost', lost_reason: 'Needs explicit save' }], ['visit', { status: 'Visited' }], ['cad', { received: true }], ['cad', { notes: 'Changed note' }, '20']]) {
  const original = { ...initial, stage, lead: { status: 'New' }, visit: { status: 'Scheduled' }, cad: { received: false, progress: 0 } };
  const view = await harness(source, original, async (_id, _version, _key, _name, payload) => ({ ...original, version: 8, stage: payload.target_stage }));
  view.state.setDraftValue(`${stage}.value`, original[stage], { ...original[stage], ...changed });
  if (progress) view.state.setDraftValue('cad.progress', '0', progress);
  view.render();
  await view.state.command('move_stage', { target_stage: stages[stages.indexOf(stage) + 1] });
  assert.deepEqual(view.writes.map(write => write.command), ['move_stage'], 'Next never autosubmits consequential status, reference or CAD progress');
  assert.equal(view.render().dirty, true, 'The explicit decision draft is retained');
}
const failedFlush = await harness(source, { ...initial, stage: 'visit' }, async () => { throw Error('Offline'); });
failedFlush.state.setDraftValue('visit.value', initial.visit, { notes: 'Keep this before Next' });
failedFlush.render();
assert.equal(await failedFlush.state.command('move_stage', { target_stage: 'cad' }), false);
assert.deepEqual(failedFlush.writes.map(write => write.command), ['save_visit']);
assert.equal(failedFlush.render().project.stage, 'visit');
assert.equal(failedFlush.state.dirty, true);
console.log('Kitchen immediate Next saves routine drafts before movement, rebases versions, retains explicit decisions, and stops safely on failed autosave.');

{
  const design = { id: 'chosen-design', response: 'Approved', handoff_status: 'Yes' };
  const original = { ...initial, stage: 'design', final_design_version_id: 'previous-design', design_versions: [design] };
  const key = 'commercial.cycle.1.design.chosen-design.edit';
  const baseline = { source: JSON.stringify([design, 'previous-design']), finalize: false, shared_date: '2026-10-26' };
  const submitted = { ...baseline, finalize: true };
  const newer = { ...submitted, shared_date: '2026-10-27' };
  const view = await harness(source, original);
  view.state.setDraftValue(key, baseline, submitted);
  view.render();
  const pending = view.state.command('design_update', { version_id: design.id, finalize: true });
  view.state.setDraftValue(key, baseline, newer);
  view.settle({ ...original, version: 8, final_design_version_id: design.id });
  assert.equal(await pending, true);
  view.render();
  assert.deepEqual(view.state.drafts[key], { ...newer, source: JSON.stringify([design, design.id]) }, 'Own final-selection acknowledgement rebases the selected project design while retaining later typing');
  assert.equal(view.state.dirty, true);
}
console.log('Kitchen final-design reconciliation: selected-design identity rebases without overwriting pending edits.');
