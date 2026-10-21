import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { RUNTIME_ROOT_FILES, RUNTIME_DIRECTORIES, RAILWAY_TARGET, validateRunningObservation, KITCHEN_RELEASE_AUTHORITY } from './promote-verified-vercel.mjs';
import { productionRequest, productionBrowserRoute, measureRunningService, verifyProtectedSource, verifyReviewedRuntimeInventory, RUNNING_SERVICE_PROBE } from './verify-kitchen-production-readonly.mjs';

// No browser launch, network, deployment, database or credentials. Exercise the
// actual mutation/redirect/bypass/identity guards through owned local adapters.
const origin = 'https://immutable.vercel.app';
const calls = [];
const context = { request: { fetch: async (...args) => { calls.push(args); return { status: () => 200 }; } } };
await productionRequest(context, origin, { 'x-vercel-protection-bypass': 'synthetic' }, 'POST', '/api/auth/login', { email: 'qa@example.test', password: 'synthetic-not-real' });
assert.equal(calls[0][0], origin + '/api/auth/login');
assert.equal(calls[0][1].maxRedirects, 0);
await productionRequest(context, origin, {}, 'GET', '/api/kitchen-projects?limit=1');
for (const [method, path] of [['POST', '/api/kitchen-projects'], ['POST', '/api/kitchen-projects/x/commands'], ['PUT', '/api/kitchen-projects/configuration'], ['DELETE', '/api/kitchen-projects/x'], ['GET', 'https://external.test/api/auth/me'], ['GET', '/api/kitchen-projects/export']])
  await assert.rejects(productionRequest(context, origin, {}, method, path));
assert.equal(calls.length, 2, 'Forbidden requests never reach transport');

function route(url, method = 'GET', status = 200) {
  const actions = [];
  return { actions, request: () => ({ url: () => url, method: () => method, headers: () => ({ 'x-vercel-protection-bypass': 'inherited', accept: '*/*' }) }),
    fetch: async options => { actions.push(['fetch', options]); return { status: () => status }; },
    abort: async reason => actions.push(['abort', reason]), continue: async options => actions.push(['continue', options]), fulfill: async options => actions.push(['fulfill', options]) };
}
let blocked = 0;
const guard = productionBrowserRoute(origin, 'synthetic-bypass', () => { blocked++; });
const mutation = route(origin + '/api/kitchen-projects', 'POST'); await guard(mutation);
assert.deepEqual(mutation.actions, [['abort', 'blockedbyclient']]);
const external = route('https://assets.example.test/a.png'); await guard(external);
assert.equal(external.actions[0][0], 'continue');
assert.equal(external.actions[0][1].headers['x-vercel-protection-bypass'], undefined);
const approved = route(origin + '/kitchen'); await guard(approved);
assert.equal(approved.actions[0][0], 'fetch'); assert.equal(approved.actions[0][1].maxRedirects, 0);
assert.equal(approved.actions[0][1].headers['x-vercel-protection-bypass'], 'synthetic-bypass');
assert.equal(approved.actions[1][0], 'fulfill');
const redirect = route(origin + '/kitchen', 'GET', 307); await guard(redirect);
assert.equal(redirect.actions[1][0], 'abort');
assert.equal(blocked, 2);
const sha = 'a'.repeat(40);
const files = Object.fromEntries([...RUNTIME_ROOT_FILES, ...RUNTIME_DIRECTORIES.map(name => name + '/fixture.py')].map(path => [path, 'b'.repeat(64)]));
const source = { schema: 'kitchen-reviewed-runtime-source/v1', source_sha: sha, files };
const runtime = { schema: 'kitchen-running-service-observation/v1', method: 'railway-ssh-readonly', observed_at: new Date().toISOString(),
  ...RAILWAY_TARGET, deployment_id: 'fixture-backend-deployment', mongo_ping: true, private_bucket_verified: true, pending_migrations: [],
  files: structuredClone(files), database_fingerprint: 'c'.repeat(64), private_storage_fingerprint: 'd'.repeat(64) };
const target = { ...RAILWAY_TARGET, deployment_id: runtime.deployment_id, source_sha: sha };
validateRunningObservation(runtime, source, target);
for (const mutate of [value => { value.method = 'local-env'; }, value => { value.deployment_id = 'another'; }, value => { value.pending_migrations = ['0036_pending']; },
  value => { value.private_bucket_verified = false; }, value => { value.mongo_ping = false; }, value => { delete value.files['models_kitchen.py']; },
  value => { value.files['models_kitchen.py'] = 'e'.repeat(64); }, value => { value.files['routes/extra.py'] = 'e'.repeat(64); }]) {
  const changed = structuredClone(runtime); mutate(changed); assert.throws(() => validateRunningObservation(changed, source, target));
}
assert.throws(() => validateRunningObservation(runtime, { ...source, files: { 'models_kitchen.py': 'b'.repeat(64) } }, target));
const prepared = { plan: { publication_mode: 'existing-site', release_sha: sha }, source, provider: { deployment_id: runtime.deployment_id }, binding: runtime };
let measurements = 0;
const measured = measureRunningService(prepared, { cli: 'fixture-railway', run(command, args, options) {
  measurements++; assert.equal(command, 'fixture-railway'); assert.equal(args[0], 'ssh'); assert.equal(args.at(-1), RUNNING_SERVICE_PROBE);
  assert.equal(args.at(-3), 'python'); assert.equal(options.timeout, 55000); assert.ok(args.includes(RAILWAY_TARGET.service_id));
  return { status: 0, stdout: JSON.stringify(runtime) };
} });
assert.equal(measured.deployment_id, runtime.deployment_id); assert.equal(measurements, 1);
assert.throws(() => measureRunningService(prepared, { run: () => ({ status: null, stdout: '' }) }), /authenticated Railway SSH/);
assert.throws(() => measureRunningService(prepared, { run: () => ({ status: 0, stdout: 'not-json' }) }), /exact credential-free JSON/);
assert.throws(() => measureRunningService(prepared, { run: () => ({ status: 0, stdout: JSON.stringify({ ...runtime, database_fingerprint: 'f'.repeat(64) }) }) }), /Fresh serving database_fingerprint/);
assert.doesNotMatch(RUNNING_SERVICE_PROBE, /run_bootstrap|run_migrations\(|insert_|update_|delete_|upload\(|load_dotenv|password|secret/i);
assert.match(RUNNING_SERVICE_PROBE, /pending_migrations\(db\)/);
const syntheticBlob = Buffer.from('synthetic runtime source\n');
const syntheticDigest = createHash('sha256').update(syntheticBlob).digest('hex');
const inventoryFiles = Object.fromEntries(Object.keys(files).map(path => [path, syntheticDigest]));
const gitSource = { ...source, files: inventoryFiles };
const gitAdapter = (command, args) => {
  assert.equal(command, 'git');
  if (args[0] === 'ls-tree') return { status: 0, stdout: Object.keys(files).map(path => `100644 blob ${'a'.repeat(40)}\tbackend/${path}\0`).join('') };
  assert.deepEqual(args, ['cat-file', '--batch']);
  return { status: 0, stdout: Buffer.concat(Object.keys(files).map(() => Buffer.concat([Buffer.from(`${'a'.repeat(40)} blob ${syntheticBlob.length}\n`), syntheticBlob, Buffer.from('\n')]))) };
};
assert.equal(verifyReviewedRuntimeInventory(gitSource, sha, { run: gitAdapter }).runtimeFilesVerifiedAgainstGit, Object.keys(files).length);
assert.throws(() => verifyReviewedRuntimeInventory({ ...gitSource, files }, sha, { run: gitAdapter }), /exact committed runtime sources/);
assert.throws(() => verifyReviewedRuntimeInventory(gitSource, sha, { run: () => ({ status: 1 }) }), /Git commit is unavailable/);
const required = ['backend', 'frontend', 'frontend-security', 'performance'];
const responses = () => [
  { commit: { sha } },
  { enforce_admins: { enabled: true }, required_status_checks: { strict: true, contexts: required }, required_pull_request_reviews: { required_approving_review_count: 1 } },
  { total_count: 4, check_runs: required.map((name, index) => ({ id: index, head_sha: sha, name, status: 'completed', conclusion: 'success' })) },
  [{ number: 16, merged_at: '2026-10-21T00:00:00Z', base: { ref: 'main' }, head: { sha: 'b'.repeat(40) }, user: { login: 'author' }, merge_commit_sha: sha }],
  [{ id: 1, state: 'APPROVED', user: { login: 'independent-reviewer' }, commit_id: 'b'.repeat(40) }],
];
function sourceCheck(change = () => {}) {
  const values = responses(); change(values); let count = 0;
  return () => verifyProtectedSource(sha, { cli: 'fixture-gh', run(command, args) {
    assert.equal(command, 'fixture-gh'); assert.equal(args[0], 'api'); assert.deepEqual(args.slice(-2), ['--method', 'GET']);
    return { status: 0, stdout: JSON.stringify(values[count++]) };
  } });
}
assert.equal(sourceCheck()().protectedMain, true);
for (const change of [v => { v[0].commit.sha = 'f'.repeat(40); }, v => { v[1].enforce_admins.enabled = false; },
  v => { v[1].required_status_checks.strict = false; }, v => { v[1].required_status_checks.contexts = ['backend']; },
  v => { v[1].required_pull_request_reviews.required_approving_review_count = 0; },
  v => { v[2].check_runs.find(row => row.name === 'frontend-security').conclusion = 'failure'; },
  v => { v[2].check_runs.find(row => row.name === 'performance').head_sha = 'f'.repeat(40); },
  v => { v[2].total_count = 101; }, v => { v[3] = []; }, v => { v[4] = []; },
  v => { v[4][0].state = 'DISMISSED'; }, v => { v[4][0].user.login = 'author'; }, v => { v[4][0].commit_id = 'f'.repeat(40); }]) assert.throws(sourceCheck(change));
assert.throws(() => verifyProtectedSource(sha, { run: () => ({ status: 1 }) }), /protected-main GitHub evidence/);
console.log('Production Kitchen readonly guards passed: exact reads/session exceptions, no redirects/secrets/business writes; fresh deployed-container inventory/data/storage identity; protected-main exact-source security/review checks. Synthetic adapters only; no live calls.');

// Freeze only the synthetic one-release fixture's clock; this preserves its
// expiry regression after the real authorization window has closed.
const ActualReleaseDate = globalThis.Date;
globalThis.Date = class extends ActualReleaseDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-21T15:00:00Z'])); }
  static now() { return ActualReleaseDate.parse('2026-10-21T15:00:00Z'); }
};
try {
const exceptionPlan = { publication_mode: 'existing-site', target_domain: 'buildconhouse.in', release_sha: sha,
  candidate_url: 'https://immutable.vercel.app', candidate_deployment_id: 'dpl_fixture', account_mode: 'existing-owner-only', run_owned_sessions: true,
  accounts: { owner: { user_id: 'existing-owner', credential_key: 'existing-owner-credential' } },
  release_exception: { schema: 'kitchen-owner-release-exception/v1', release: 'kitchen-nine-page-2026-10-21', source_sha: sha,
    candidate_url: 'https://immutable.vercel.app', candidate_deployment_id: 'dpl_fixture', target_domain: 'buildconhouse.in',
    owner_only: true, expires_at: '2026-10-22T18:29:59Z', waivers: ['frontend-security', 'independent-review', 'protected-main-publication'],
    authority: { ...KITCHEN_RELEASE_AUTHORITY, verified_via: 'codex.read_thread', answer: 'Authorize this release exception' } } };
function exceptionSourceCheck(change = () => {}) {
  const values = responses().slice(0, 3);
  values[0].commit.sha = 'f'.repeat(40); // Source deliberately remains unmerged.
  values[2].check_runs.find(row => row.name === 'frontend-security').conclusion = 'failure';
  values.push({ number: 16, state: 'open', base: { ref: 'main' }, head: { sha } });
  change(values); let count = 0;
  return verifyProtectedSource(sha, { plan: exceptionPlan, cli: 'fixture-gh', run(command, args) {
    assert.equal(command, 'fixture-gh'); assert.equal(args[0], 'api');
    return { status: 0, stdout: JSON.stringify(values[count++]) };
  } });
}
const waived = exceptionSourceCheck();
assert.equal(waived.protectedMain, false); assert.equal(waived.branchProtectionsPreserved, true);
assert.equal(waived.frontendSecurity.actualConclusion, 'failure'); assert.equal(waived.frontendSecurity.passed, false);
assert.equal(waived.independentReview.approved, false);
for (const change of [
  v => { v[1].enforce_admins.enabled = false; }, v => { v[1].required_status_checks.strict = false; },
  v => { v[1].required_status_checks.contexts = ['backend']; }, v => { v[1].required_pull_request_reviews.required_approving_review_count = 0; },
  ...['backend', 'frontend', 'performance'].map(name => v => { v[2].check_runs.find(row => row.name === name).conclusion = 'failure'; }),
  v => { v[2].check_runs.find(row => row.name === 'performance').head_sha = 'f'.repeat(40); },
  v => { v[2].check_runs.find(row => row.name === 'frontend-security').status = 'in_progress'; },
  v => { v[3].head.sha = 'f'.repeat(40); }, v => { v[3].state = 'closed'; },
]) assert.throws(() => exceptionSourceCheck(change));
assert.throws(() => measureRunningService({ ...prepared, releaseException: exceptionPlan.release_exception }, { run: () => ({ status: 0, stdout: JSON.stringify({ ...runtime, kitchen_owner_only: false }) }) }), /owner-only/);
assert.doesNotMatch(RUNNING_SERVICE_PROBE, /insert_|update_|delete_|upload\(/);
console.log('Exception source guard: unchanged strict/admin/review/check protections, exact open PR head, backend/frontend/performance success and completed real security result required; waived failures are explicitly reported unpassed. No live calls.');

} finally { globalThis.Date = ActualReleaseDate; }
