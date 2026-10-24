import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const team = 'team_TNMtYYjniBWtCj1l58NEFSPG';
const project = 'prj_RuZWSvov1AkP2UDmWaea6925wWlU';
// Retained only for historical isolated-trial packages. Existing-site release
// qualification uses a read-only observation inside the running deployment.
export const KITCHEN_BINDING_PATH = '/api/health/kitchen-release-binding';
export const EXISTING_SITE_DOMAIN = 'buildconhouse.in';
export const RAILWAY_TARGET = Object.freeze({ project_id: '4d4a8d55-2e5e-43dc-b3a2-298e4455f210', environment_id: '3ee5a85e-c436-4010-8103-8e8a49186dd1', service_id: '9683fa61-7c70-4fce-ba6d-210b0cff5267' });
export const KITCHEN_RELEASE_AUTHORITY = Object.freeze({
  thread_id: '01a15b3b-d46b-7d00-8f07-0eb1100c142c',
  exception_turn_id: '01a15dff-7167-73b0-a171-d76fbd4933bd',
  owner_only_turn_id: '01a15e19-d93d-71b1-9a2e-5a30613d3beb',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reference = value => assert.ok(typeof value === 'string' && value.trim().length >= 6, 'Missing reviewed evidence reference');
const review = value => { assert.equal(value?.approved, true, 'Evidence must be independently reviewed'); reference(value.reviewer); reference(value.reference); };
export function canonicalCandidate(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && url.hostname.endsWith('.vercel.app') && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Use an HTTPS canonical candidate deployment URL');
  return url;
}
// A manifest must deliberately bind this retrieved human instruction to one
// candidate and source. It never follows from an environment flag or old note.
// The fixed release window prevents reusing this authority for future releases.
export function validateReleaseException(plan, sha) {
  const exception = plan.release_exception;
  if (exception === undefined) return null;
  assert.equal(exception?.schema, 'kitchen-owner-release-exception/v1');
  assert.equal(plan.publication_mode, 'existing-site');
  assert.equal(plan.target_domain, EXISTING_SITE_DOMAIN);
  assert.equal(exception.release, 'kitchen-nine-page-2026-10-21');
  assert.equal(plan.release_sha, sha); assert.match(sha || '', /^[a-f0-9]{40}$/);
  assert.equal(exception.source_sha, sha);
  assert.equal(exception.candidate_deployment_id, plan.candidate_deployment_id);
  assert.ok(/^dpl_[A-Za-z0-9_-]+$/.test(plan.candidate_deployment_id || ''));
  assert.equal(canonicalCandidate(exception.candidate_url).origin, canonicalCandidate(plan.candidate_url).origin);
  assert.equal(exception.target_domain, EXISTING_SITE_DOMAIN);
  for (const [key, value] of Object.entries(KITCHEN_RELEASE_AUTHORITY)) assert.equal(exception.authority?.[key], value, 'Wrong retrieved human release authority');
  assert.equal(exception.authority?.verified_via, 'codex.read_thread');
  assert.equal(exception.authority?.answer, 'Authorize this release exception');
  assert.equal(exception.owner_only, true);
  assert.deepEqual(exception.waivers?.slice().sort(), ['frontend-security', 'independent-review', 'protected-main-publication']);
  const expiry = Date.parse(exception.expires_at);
  assert.ok(Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.parse('2026-10-22T18:29:59Z'), 'One-release exception is missing or outside its release window');
  assert.equal(plan.account_mode, 'existing-owner-only');
  assert.equal(plan.run_owned_sessions, true);
  reference(plan.accounts?.owner?.credential_key); reference(plan.accounts?.owner?.user_id);
  assert.equal(plan.accounts?.denied, undefined, 'Owner-only qualification must not introduce another principal');
  return exception;
}
export function validateRuntimeBinding(binding, environment, candidate, sha) {
  assert.equal(binding?.schema, 'kitchen-runtime-binding/v1', 'Measured runtime binding proof is required');
  assert.equal(binding.environment, environment, 'Runtime environment differs from reviewed proof');
  assert.equal(binding.evidenceKind, 'measured-runtime', 'Operator-supplied identities are not measured binding');
  assert.equal(canonicalCandidate(binding.candidate_url).origin, canonicalCandidate(candidate).origin);
  assert.equal(binding.frontend_source_sha, sha); assert.equal(binding.backend_source_sha, sha);
  for (const field of ['frontend_deployment_id', 'backend_deployment_id']) assert.match(binding[field] || '', /^dpl_[A-Za-z0-9_-]+$|^[a-f0-9-]{36}$/, 'Missing deployment identity');
  for (const field of ['database_fingerprint', 'private_storage_fingerprint']) assert.match(binding[field] || '', /^[a-f0-9]{64}$/, 'Use credential-free SHA256 fingerprints');
  assert.equal(binding.measurement?.method, 'authenticated-runtime-probe');
  assert.equal(binding.measurement?.probe_path, KITCHEN_BINDING_PATH);
  assert.ok(Number.isFinite(Date.parse(binding.measurement?.observed_at)), 'Missing measurement time');
  review(binding.review);
}

const digestPattern = /^[a-f0-9]{64}$/;
export const RUNTIME_ROOT_FILES = ['access_profiles.py', 'auth.py', 'bootstrap.py', 'catalog_policy.py', 'db.py', 'middleware.py', 'models.py', 'models_kitchen.py', 'models_tile_orders.py', 'models_walkins.py', 'pdf_chalan.py', 'pdf_generator.py', 'pdf_tiles.py', 'seed.py', 'server.py', 'settings.py'];
export const RUNTIME_DIRECTORIES = ['migrations', 'media_storage', 'routes', 'services', 'catalog_pipeline'];
export function validateRunningObservation(observed, source, target) {
  assert.equal(observed?.schema, 'kitchen-running-service-observation/v1', 'Missing read-only running-service observation');
  assert.equal(observed.method, 'railway-ssh-readonly', 'Runtime evidence must come from the deployed container, not local environment variables');
  assert.equal(source?.schema, 'kitchen-reviewed-runtime-source/v1', 'Missing reviewed build-input file inventory');
  assert.equal(source.source_sha, target.source_sha, 'Reviewed runtime file inventory belongs to another source');
  for (const key of ['project_id', 'environment_id', 'service_id', 'deployment_id'])
    assert.equal(observed[key], target[key], `Running Railway ${key} differs from reviewed target`);
  assert.ok(Array.isArray(observed.pending_migrations) && observed.pending_migrations.length === 0, 'Running backend still has pending migrations');
  assert.equal(observed.mongo_ping, true, 'Running database read-only ping failed');
  assert.equal(observed.private_bucket_verified, true, 'Running private storage access is unverified');
  for (const key of ['database_fingerprint', 'private_storage_fingerprint']) assert.match(observed[key] || '', digestPattern, `Missing measured ${key}`);
  assert.ok(source.files && observed.files && Object.keys(source.files).length >= RUNTIME_ROOT_FILES.length, 'Runtime source inventory is incomplete');
  for (const file of RUNTIME_ROOT_FILES) assert.match(source.files[file] || '', digestPattern, `Reviewed runtime inventory omits ${file}`);
  for (const directory of RUNTIME_DIRECTORIES) assert.ok(Object.keys(source.files).some(file => file.startsWith(directory + '/')), `Reviewed runtime inventory omits ${directory}`);
  for (const [file, digest] of Object.entries(source.files)) {
    assert.ok(!file.includes('..') && (RUNTIME_ROOT_FILES.includes(file) || RUNTIME_DIRECTORIES.some(directory => file.startsWith(directory + '/'))), 'Runtime inventory contains an unapproved path');
    assert.match(digest, digestPattern, 'Malformed reviewed runtime file hash');
  }
  assert.deepEqual(observed.files, source.files, 'Running packaged source files differ from the reviewed release inventory');
}
function fresh(value, label) {
  const time = Date.parse(value);
  assert.ok(Number.isFinite(time) && time <= Date.now() + 60000 && Date.now() - time <= 3600000, `${label} must be measured within the last hour`);
}

/** Validate existing-site evidence without creating evidence or making writes.
 * Reviewed statements remain separate from measured files/provider observations. */
export function loadKitchenPromotionPackage({ manifestPath, candidate, sha, read = readFileSync }) {
  assert.match(sha || '', /^[a-f0-9]{40}$/, 'Complete reviewed source SHA required');
  assert.ok(typeof manifestPath === 'string' && manifestPath.length, 'A reviewed Kitchen production promotion manifest is required');
  const bytes = read(manifestPath), plan = JSON.parse(bytes.toString());
  assert.equal(plan.schema, 'kitchen-production-promotion/v1');
  assert.equal(canonicalCandidate(plan.candidate_url).origin, canonicalCandidate(candidate).origin);
  assert.equal(plan.release_sha, sha);
  const artifact = descriptor => {
    assert.ok(descriptor?.path, 'Missing required hashed evidence artifact'); assert.match(descriptor.sha256 || '', digestPattern, 'Missing evidence artifact SHA256');
    const content = read(resolve(dirname(manifestPath), descriptor.path));
    assert.equal(hash(content), descriptor.sha256, 'Reviewed evidence hash changed');
    return JSON.parse(content.toString());
  };
  let trial = null, binding, source, runtime, provider, recovery;
  if (plan.publication_mode === 'existing-site') {
    assert.equal(plan.target_domain, EXISTING_SITE_DOMAIN, 'Existing-site release must name the existing public domain');
    review(plan.production_binding?.review);
    binding = artifact(plan.production_binding);
    assert.equal(binding.schema, 'kitchen-existing-site-binding/v1');
    assert.equal(binding.environment, 'production');
    assert.equal(binding.evidenceKind, 'provider-and-running-container-measurements', 'Operator attestation cannot substitute for runtime measurements');
    assert.equal(canonicalCandidate(binding.candidate_url).origin, canonicalCandidate(candidate).origin);
    assert.equal(binding.frontend_deployment_id, plan.candidate_deployment_id);
    assert.equal(binding.frontend_source_sha, sha);
    source = artifact(binding.reviewed_runtime_source); review(binding.reviewed_runtime_source.review);
    runtime = artifact(binding.running_service);
    provider = artifact(binding.railway_provider);
    assert.equal(provider.schema, 'railway-settled-deployment-observation/v1', 'Missing settled provider deployment observation');
    assert.equal(provider.method, 'authenticated-provider-read');
    fresh(provider.observed_at, 'Railway provider observation'); fresh(runtime.observed_at, 'Running-service observation');
    assert.equal(provider.status, 'SUCCESS', 'Backend deployment is not settled SUCCESS');
    assert.equal(provider.pending_operations, 0, 'Backend deployment has pending operations');
    assert.equal(provider.running_replicas, 1, 'Measure the existing single running replica');
    for (const [key, value] of Object.entries(RAILWAY_TARGET)) assert.equal(provider[key], value, `Railway provider ${key} is not the existing service`);
    validateRunningObservation(runtime, source, { ...RAILWAY_TARGET, deployment_id: provider.deployment_id, source_sha: sha });
    assert.equal(binding.backend_deployment_id, runtime.deployment_id);
    for (const key of ['database_fingerprint', 'private_storage_fingerprint']) assert.equal(binding[key], runtime[key], 'Reviewed data/storage binding differs from running-service measurement');
    recovery = artifact(plan.recovery); review(plan.recovery.review);
    assert.equal(recovery.schema, 'kitchen-reviewed-recovery/v1', 'Missing actual backup/restore evidence');
    assert.equal(recovery.backup_verified, true, 'Private backup has not been verified');
    assert.equal(recovery.isolated_restore_verified, true, 'Backup restore has not been verified in an empty distinct destination');
    assert.equal(recovery.private_objects_bytes_verified, true, 'Restored private object bytes/access have not been verified');
    assert.equal(recovery.restore_target_distinct, true, 'Recovery drill must never target the operating database');
    for (const key of ['database_fingerprint', 'private_storage_fingerprint']) assert.equal(recovery[key], runtime[key], 'Recovery evidence belongs to another live source');
    for (const key of ['backup_reference', 'restore_reference', 'operator', 'retention_reference', 'recovery_targets_reference']) reference(recovery[key]);
    assert.match(recovery.backup_manifest_sha256 || '', digestPattern, 'Missing verified backup manifest hash');
    assert.ok(Number.isFinite(Date.parse(recovery.verified_at)), 'Recovery verification time missing');
    assert.equal(plan.authorization?.publication_mode, 'existing-site');
    reference(plan.authorization?.human_instruction_reference);
  } else {
    assert.ok(plan.publication_mode === undefined || plan.publication_mode === 'isolated-trial-qualified', 'Unknown publication mode');
    review(plan.isolated_trial?.review);
    trial = artifact(plan.isolated_trial);
    assert.equal(trial.passed, true, 'Isolated trial did not pass');
    assert.equal(trial.productionPromoted, false, 'Trial must not have been promoted');
    assert.equal(trial.releaseSha, sha, 'Trial tested another source');
    assert.ok(Number.isFinite(Date.parse(trial.finishedAt)), 'Trial did not finish');
    assert.notEqual(canonicalCandidate(trial.candidate).origin, canonicalCandidate(candidate).origin, 'An isolated trial candidate must never become production');
    validateRuntimeBinding(trial.runtimeBinding, 'isolated', trial.candidate, sha);
    for (const check of ['runtime-binding-measured', 'private-25mb-bounded-upload-download', 'actual-hosted-lifecycle-private-bytes-idempotent-visits-export-and-denials', 'CSRF-rejection'])
      assert.ok(trial.checks?.some(row => row.check === check && row.passed === true), 'Required isolated trial check missing');
    assert.ok(trial.checks.every(row => row.passed === true), 'Trial contains unsuccessful checks');
    binding = artifact(plan.production_binding);
    validateRuntimeBinding(binding, 'production', candidate, sha);
    assert.equal(binding.frontend_deployment_id, plan.candidate_deployment_id);
    for (const field of ['frontend_deployment_id', 'backend_deployment_id', 'database_fingerprint', 'private_storage_fingerprint'])
      assert.notEqual(binding[field], trial.runtimeBinding[field], 'Production and isolated trial must have distinct deployment/data/storage bindings');
  }
  const authorization = plan.authorization;
  assert.equal(authorization?.owner_approved, true, 'Explicit owner authorization is required');
  assert.equal(authorization.action, 'promote-production-aliases');
  assert.equal(authorization.candidate_deployment_id, plan.candidate_deployment_id);
  assert.equal(authorization.source_sha, sha);
  reference(authorization.reference); reference(authorization.rollback_reference); reference(authorization.rollback_deployment_id);
  assert.notEqual(authorization.rollback_deployment_id, plan.candidate_deployment_id);
  assert.ok(Date.parse(authorization.expires_at) > Date.now(), 'Production authorization expired');
  const releaseException = validateReleaseException(plan, sha);
  if (releaseException) {
    assert.equal(runtime.kitchen_owner_only, true, 'Running Kitchen owner-only launch flag is not verified');
  } else {
    assert.equal(plan.run_owned_qa_accounts, true);
    for (const role of ['owner', 'denied']) {
      reference(plan.accounts?.[role]?.credential_key); reference(plan.accounts?.[role]?.user_id);
    }
    assert.notEqual(plan.accounts.owner.user_id, plan.accounts.denied.user_id);
  }
  return { plan, trial, binding, source, runtime, provider, recovery, releaseException, manifestSha256: hash(bytes), trialSha256: trial ? plan.isolated_trial.sha256 : null };
}

export function promoteVerified({ candidate, sha, report, kitchenManifest = process.env.FORGE_KITCHEN_PROMOTION_MANIFEST, cli = 'vercel', run = spawnSync, read = readFileSync }) {
  const url = canonicalCandidate(candidate);
  assert.match(sha, /^[a-f0-9]{40}$/, 'Provide the complete reviewed source SHA');
  // Missing evidence/approval stops even before provider inspection. No trial
  // runner is invoked here: all production business mutations are forbidden.
  const prepared = loadKitchenPromotionPackage({ manifestPath: kitchenManifest, candidate, sha, read });
  const metadata = run(cli, ['api', `/v13/deployments/${encodeURIComponent(url.hostname)}?teamId=${team}`, '--method', 'GET'], { encoding: 'utf8' });
  assert.equal(metadata.status, 0, 'Cannot inspect deployment; production promotion stopped');
  const deployment = JSON.parse(metadata.stdout);
  assert.equal(deployment.projectId, project, 'Candidate belongs to another project');
  assert.equal(deployment.readyState, 'READY', 'Candidate is not ready');
  assert.equal(deployment.url, url.hostname, 'Mutable aliases cannot identify the tested production artifact');
  assert.equal(deployment.id, prepared.plan.candidate_deployment_id);
  assert.equal(deployment.meta?.releaseSha, sha, 'Candidate source differs from reviewed source');
  const verification = run(process.execPath, [fileURLToPath(new URL('./verify-production-release.mjs', import.meta.url)), url.origin, ...(report ? [report] : [])], { stdio: 'inherit' });
  assert.equal(verification.status, 0, 'Candidate runtime/API/security verification failed; production promotion stopped');
  const browserVerification = run(process.execPath, [fileURLToPath(new URL('./verify-authenticated-release.mjs', import.meta.url)), url.origin, sha, ...(report ? [report.replace(/\.json$/, '') + '-authenticated.json'] : [])], { stdio: 'inherit' });
  assert.equal(browserVerification.status, 0, 'Candidate authenticated browser/session verification failed; production promotion stopped');
  const quotationVerification = run(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('./verify-quotation-release.mjs', import.meta.url)), url.origin, sha, ...(report ? [report.replace(/\.json$/, '') + '-quotations.json'] : [])], { stdio: 'inherit' });
  assert.equal(quotationVerification.status, 0, 'Candidate populated quotation verification failed; production promotion stopped');
  const kitchenVerification = run(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('./verify-kitchen-production-readonly.mjs', import.meta.url)), kitchenManifest,
    report ? report.replace(/\.json$/, '') + '-kitchen-readonly.json' : 'output/hosted-kitchen-production-readonly.json', url.origin, sha, deployment.id, prepared.manifestSha256], { stdio: 'inherit' });
  assert.equal(kitchenVerification.status, 0, 'Production Kitchen read-only binding/auth verification failed; promotion stopped');
  const promotion = run(cli, ['promote', deployment.id, '--yes', '--scope', team], { stdio: 'inherit' });
  assert.equal(promotion.status, 0, 'Vercel promotion did not complete');
  return { id: deployment.id, sourceSha: sha, isolatedTrialSha256: prepared.trialSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [candidate, sha, report] = process.argv.slice(2);
  console.log(promoteVerified({ candidate, sha, report, cli: process.env.FORGE_VERCEL_CLI || 'vercel' }));
}
