import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { promoteVerified, KITCHEN_BINDING_PATH, loadKitchenPromotionPackage, RUNTIME_ROOT_FILES, RUNTIME_DIRECTORIES, RAILWAY_TARGET } from './promote-verified-vercel.mjs';
import { assertPersistentCookies } from './verify-release-cookies.mjs';
const sha = 'a'.repeat(40);
const digest = value => createHash('sha256').update(value).digest('hex');
const reviewer = { approved: true, reviewer: 'independent-reviewer', reference: 'review-reference' };
const binding = (environment, hostname, id, byte) => ({ schema: 'kitchen-runtime-binding/v1', evidenceKind: 'measured-runtime', environment,
  candidate_url: `https://${hostname}`, frontend_deployment_id: id, frontend_source_sha: sha,
  backend_deployment_id: `dpl_backend_${environment}`, backend_source_sha: sha,
  database_fingerprint: byte.repeat(64), private_storage_fingerprint: (environment === 'isolated' ? 'c' : 'd').repeat(64),
  measurement: { method: 'authenticated-runtime-probe', probe_path: KITCHEN_BINDING_PATH, observed_at: '2026-10-21T00:00:00Z' }, review: reviewer });
// Synthetic evidence/CLI only. These values do not attest any real environment.
const productionBinding = binding('production', 'candidate.vercel.app', 'dpl_fixture', 'b');
const trial = { passed: true, productionPromoted: false, candidate: 'https://isolated.vercel.app', releaseSha: sha,
  finishedAt: '2026-10-21T00:00:00Z', runtimeBinding: binding('isolated', 'isolated.vercel.app', 'dpl_isolated', 'a'),
  checks: ['runtime-binding-measured', 'private-25mb-bounded-upload-download', 'actual-hosted-lifecycle-private-bytes-idempotent-visits-export-and-denials', 'CSRF-rejection'].map(check => ({ check, passed: true })) };
const base = { id: 'dpl_fixture', url: 'candidate.vercel.app', projectId: 'prj_RuZWSvov1AkP2UDmWaea6925wWlU', readyState: 'READY', meta: { releaseSha: sha } };
function fixture({ changePlan = () => {}, changeTrial = () => {}, changeBinding = () => {} } = {}) {
  const trialValue = structuredClone(trial), bindingValue = structuredClone(productionBinding);
  changeTrial(trialValue); changeBinding(bindingValue);
  const trialBytes = JSON.stringify(trialValue), bindingBytes = JSON.stringify(bindingValue);
  const plan = { schema: 'kitchen-production-promotion/v1', candidate_url: 'https://candidate.vercel.app', candidate_deployment_id: 'dpl_fixture', release_sha: sha,
    isolated_trial: { path: 'trial.json', sha256: digest(trialBytes), review: reviewer }, production_binding: { path: 'binding.json', sha256: digest(bindingBytes) },
    authorization: { owner_approved: true, action: 'promote-production-aliases', candidate_deployment_id: 'dpl_fixture', source_sha: sha,
      reference: 'owner-approved-specific-action', rollback_reference: 'reviewed-rollback', rollback_deployment_id: 'dpl_previous', expires_at: '2099-01-01T00:00:00Z' },
    run_owned_qa_accounts: true, accounts: { owner: { credential_key: 'qa-owner', user_id: 'qa-owner-id' }, denied: { credential_key: 'qa-denied', user_id: 'qa-denied-id' } } };
  changePlan(plan);
  const files = new Map([['/private/manifest.json', JSON.stringify(plan)], ['/private/trial.json', trialBytes], ['/private/binding.json', bindingBytes]]);
  return { plan, files, read: path => { assert(files.has(path), 'Fixture file missing'); return Buffer.from(files.get(path)); } };
}
function exercise({ metadata = base, fail = -1, candidate = 'https://candidate.vercel.app', report, kitchenManifest = '/private/manifest.json', ...options } = {}) {
  const calls = [], input = fixture(options); let error;
  try {
    promoteVerified({ candidate, sha, report, kitchenManifest, read: input.read, cli: 'fixture-vercel', run(command, args) {
      const stage = calls.length; calls.push({ command, args });
      return { status: stage === fail ? 1 : 0, stdout: stage === 0 ? JSON.stringify(metadata) : '' };
    } });
  } catch (failure) { error = failure; }
  return { calls, error };
}
const good = exercise();
assert.equal(good.error, undefined); assert.equal(good.calls.length, 6);
assert.ok(good.calls[4].args[2].endsWith('verify-kitchen-production-readonly.mjs'));
assert(!good.calls.some(call => call.args.some(arg => String(arg).endsWith('verify-kitchen-hosted-release.mjs'))), 'Promotion must never run the write-bearing isolated trial');
assert.deepEqual(good.calls[5].args.slice(0, 2), ['promote', 'dpl_fixture']);
for (const [fail, expected] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]) {
  const result = exercise({ fail }); assert.ok(result.error); assert.equal(result.calls.length, expected);
}
for (const metadata of [{ ...base, readyState: 'ERROR' }, { ...base, projectId: 'other-project' }, { ...base, meta: { releaseSha: 'b'.repeat(40) } }, { ...base, id: 'dpl_other' }, { ...base, url: 'immutable-other.vercel.app' }]) {
  const result = exercise({ metadata }); assert.ok(result.error); assert.equal(result.calls.length, 1);
}
for (const candidate of ['http://candidate.vercel.app', 'https://evil.test', 'https://user:password@candidate.vercel.app', 'https://candidate.vercel.app/other']) {
  const result = exercise({ candidate }); assert.ok(result.error); assert.equal(result.calls.length, 0);
}
for (const options of [
  { kitchenManifest: null },
  { changePlan: plan => { plan.isolated_trial.sha256 = 'f'.repeat(64); } },
  { changePlan: plan => { plan.authorization.owner_approved = false; } },
  { changePlan: plan => { plan.authorization.candidate_deployment_id = 'dpl_other'; } },
  { changePlan: plan => { plan.authorization.action = 'run-trial'; } },
  { changePlan: plan => { plan.authorization.rollback_deployment_id = 'dpl_fixture'; } },
  { changePlan: plan => { plan.authorization.expires_at = '2000-01-01T00:00:00Z'; } },
  { changePlan: plan => { plan.production_binding = null; } },
  { changeTrial: value => { value.releaseSha = 'b'.repeat(40); } },
  { changeTrial: value => { value.passed = false; } },
  { changeTrial: value => { value.candidate = 'https://candidate.vercel.app'; } },
  { changeTrial: value => { value.runtimeBinding.evidenceKind = 'operator-supplied'; } },
  { changeTrial: value => { value.runtimeBinding.backend_source_sha = 'b'.repeat(40); } },
  { changeBinding: value => { value.evidenceKind = 'operator-supplied'; } },
  { changeBinding: value => { value.database_fingerprint = trial.runtimeBinding.database_fingerprint; } },
]) {
  const result = exercise(options); assert.ok(result.error, JSON.stringify(options)); assert.equal(result.calls.length, 0, 'Insufficient proof must stop before any provider call');
}
for (const report of ['output/release.json', 'output/release']) {
  const result = exercise({ report }); assert.equal(result.error, undefined);
  assert.equal(result.calls[4].args[4], report.replace(/\.json$/, '') + '-kitchen-readonly.json');
}
const loaded = fixture();
assert.equal(loadKitchenPromotionPackage({ manifestPath: '/private/manifest.json', candidate: 'https://candidate.vercel.app', sha, read: loaded.read }).trialSha256, loaded.plan.isolated_trial.sha256);
console.log('Synthetic promotion guard: hashes/reviews/source/environment/approval/rollback/canonical-candidate binding, no trial writes, and every failed stage blocks promotion. No live calls made.');

// Existing-site publication deliberately does not need an isolated hosted site
// or a fabricated endpoint. The proof is still real provider/container/recovery
// evidence in a real run; these are strictly local synthetic adapter fixtures.
function existingFixture({ changePlan = () => {}, changeRuntime = () => {}, changeProvider = () => {}, changeRecovery = () => {}, changeSource = () => {}, changeBinding = () => {} } = {}) {
  const input = fixture(); const plan = input.plan;
  plan.publication_mode = 'existing-site'; plan.target_domain = 'buildconhouse.in'; delete plan.isolated_trial;
  plan.authorization.publication_mode = 'existing-site'; plan.authorization.human_instruction_reference = 'user-current-existing-site-publication';
  const files = Object.fromEntries([...RUNTIME_ROOT_FILES, ...RUNTIME_DIRECTORIES.map(name => name + '/fixture.py')].map(file => [file, 'e'.repeat(64)]));
  const source = { schema: 'kitchen-reviewed-runtime-source/v1', source_sha: sha, files }; changeSource(source);
  const runtime = { schema: 'kitchen-running-service-observation/v1', method: 'railway-ssh-readonly', observed_at: new Date().toISOString(),
    ...RAILWAY_TARGET, deployment_id: 'fixture-backend-deployment', files: structuredClone(files), database_fingerprint: 'b'.repeat(64), private_storage_fingerprint: 'd'.repeat(64),
    mongo_ping: true, private_bucket_verified: true, pending_migrations: [] }; changeRuntime(runtime);
  const provider = { schema: 'railway-settled-deployment-observation/v1', method: 'authenticated-provider-read', observed_at: new Date().toISOString(),
    ...RAILWAY_TARGET, deployment_id: 'fixture-backend-deployment', status: 'SUCCESS', pending_operations: 0, running_replicas: 1,
    configured_git_sha: 'f'.repeat(40) }; changeProvider(provider); // Deliberately NOT used as running-source proof.
  const recovery = { schema: 'kitchen-reviewed-recovery/v1', backup_verified: true, isolated_restore_verified: true, private_objects_bytes_verified: true,
    restore_target_distinct: true, database_fingerprint: 'b'.repeat(64), private_storage_fingerprint: 'd'.repeat(64), backup_reference: 'private-backup-reference', restore_reference: 'private-restore-reference',
    operator: 'reviewed-operator', retention_reference: 'reviewed-retention', recovery_targets_reference: 'reviewed-rpo-rto', backup_manifest_sha256: '9'.repeat(64), verified_at: new Date().toISOString() }; changeRecovery(recovery);
  const attach = (name, value, reviewed = false) => { const content = JSON.stringify(value); input.files.set('/private/' + name, content); return { path: name, sha256: digest(content), ...(reviewed ? { review: reviewer } : {}) }; };
  const binding = { schema: 'kitchen-existing-site-binding/v1', environment: 'production', evidenceKind: 'provider-and-running-container-measurements',
    candidate_url: plan.candidate_url, frontend_deployment_id: plan.candidate_deployment_id, frontend_source_sha: sha, backend_deployment_id: 'fixture-backend-deployment',
    database_fingerprint: 'b'.repeat(64), private_storage_fingerprint: 'd'.repeat(64), reviewed_runtime_source: attach('source.json', source, true),
    running_service: attach('runtime.json', runtime), railway_provider: attach('provider.json', provider) }; changeBinding(binding);
  plan.production_binding = attach('binding.json', binding, true); plan.recovery = attach('recovery.json', recovery, true); changePlan(plan);
  input.files.set('/private/manifest.json', JSON.stringify(plan));
  return input;
}
function existingExercise(options = {}) {
  const input = existingFixture(options), calls = []; let error;
  try { promoteVerified({ candidate: input.plan.candidate_url, sha, kitchenManifest: '/private/manifest.json', read: input.read, run(command, args) {
    calls.push({ command, args }); return { status: 0, stdout: calls.length === 1 ? JSON.stringify(base) : '' };
  } }); } catch (value) { error = value; }
  return { input, calls, error };
}
const existing = existingExercise(); assert.equal(existing.error, undefined); assert.equal(existing.calls.length, 6);
const loadedExisting = loadKitchenPromotionPackage({ manifestPath: '/private/manifest.json', candidate: existing.input.plan.candidate_url, sha, read: existing.input.read });
assert.equal(loadedExisting.trial, null); assert.equal(loadedExisting.trialSha256, null);
assert(!existing.calls.some(call => call.args.some(arg => String(arg).endsWith('verify-kitchen-hosted-release.mjs'))));
for (const options of [
  { changePlan: v => { delete v.authorization.human_instruction_reference; } },
  { changePlan: v => { v.target_domain = 'unrelated.example'; } },
  { changePlan: v => { delete v.recovery; } },
  { changePlan: v => { v.production_binding.sha256 = 'f'.repeat(64); } },
  { changeBinding: v => { delete v.running_service; } },
  { changeBinding: v => { v.evidenceKind = 'operator-attestation'; } },
  { changeRuntime: v => { v.deployment_id = 'another'; } },
  { changeRuntime: v => { v.method = 'local-environment'; } },
  { changeRuntime: v => { v.observed_at = '2000-01-01T00:00:00Z'; } },
  { changeRuntime: v => { v.observed_at = '2099-01-01T00:00:00Z'; } },
  { changeRuntime: v => { v.pending_migrations = ['0037_pending']; } },
  { changeRuntime: v => { v.files['models_kitchen.py'] = 'f'.repeat(64); } },
  { changeProvider: v => { v.method = 'operator-attestation'; } },
  { changeProvider: v => { v.status = 'BUILDING'; } },
  { changeProvider: v => { v.pending_operations = 1; } },
  { changeProvider: v => { v.project_id = 'another'; } },
  { changeProvider: v => { v.observed_at = '2000-01-01T00:00:00Z'; } },
  { changeRecovery: v => { v.backup_verified = false; } },
  { changeRecovery: v => { v.isolated_restore_verified = false; } },
  { changeRecovery: v => { v.private_objects_bytes_verified = false; } },
  { changeRecovery: v => { v.restore_target_distinct = false; } },
  { changeRecovery: v => { v.database_fingerprint = 'f'.repeat(64); } },
  { changeSource: v => { v.source_sha = 'f'.repeat(40); } },
  { changeSource: v => { delete v.files['models_kitchen.py']; } },
]) {
  const result = existingExercise(options); assert.ok(result.error, 'Missing/mismatched existing-site evidence must fail');
  assert.equal(result.calls.length, 0, 'Insufficient evidence stops before any provider call');
}
console.log('Existing-site promotion package passed: no isolated-host dependency; missing/stale/tampered/provider/container/source/backup/rollback/user-instruction proof fails before provider calls. Synthetic evidence only.');

const cookieFixture = [
  { name: 'forge_session', expires: 2000.358264, path: '/api', httpOnly: true, secure: true, sameSite: 'Strict' },
  { name: 'forge_csrf', expires: 2000.358327, path: '/', httpOnly: false, secure: true, sameSite: 'Strict' },
];
const issued = ['forge_session=fixture; Path=/api; Max-Age=1000; Expires=Thu, 01 Jan 1970 00:33:20 GMT; Secure; HttpOnly; SameSite=Strict', 'forge_csrf=fixture; Path=/; Max-Age=1000; Expires=Thu, 01 Jan 1970 00:33:20 GMT; Secure; SameSite=Strict'];
assertPersistentCookies(cookieFixture, 2001, issued, 1000);
for (const patch of [{ expires: -1 }, { expires: 2010 }, { expires: 1990 }, { secure: false }, { httpOnly: true }, { sameSite: 'Lax' }]) {
  assert.throws(() => assertPersistentCookies([cookieFixture[0], { ...cookieFixture[1], ...patch }], 2001, issued, 1000));
}
assert.throws(() => assertPersistentCookies(cookieFixture, 2001, [issued[0], issued[1].replace('Max-Age=1000', 'Max-Age=1001')], 1000));
assert.throws(() => assertPersistentCookies(cookieFixture, 2001, [], 1000));
console.log('Persistent-cookie acceptance tolerates browser timestamp precision while rejecting mismatched server expiry, session-only cookies, insecure flags and JWT lifetime extension.');
