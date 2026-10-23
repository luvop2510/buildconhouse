import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FRONTEND_CANONICAL_DOMAIN, FRONTEND_PROJECT_ID, FRONTEND_TEAM_ID, loadFrontendPromotionPackage, promoteVerifiedFrontend } from './promote-verified-frontend.mjs';

const frontendSha = 'a'.repeat(40), backendSha = 'b'.repeat(40), previousSha = 'c'.repeat(40);
const digest = value => createHash('sha256').update(value).digest('hex');
const reviewer = { reviewer: 'independent-agent', reference: 'review-of-exact-diff', accepted: true, independent: true };
const candidateUrl = 'https://immutable-candidate.vercel.app';
const candidateId = 'dpl_frontend_fixture', previousId = 'dpl_previous_fixture';
const currentTime = Date.now();
const changedPaths = ['app/_layout.web.tsx', 'e2e/frontend-recovery.spec.ts', 'scripts/web-worker.mjs'].sort();
const envValue = 'encrypted-test-value-not-a-secret';
const environment = { schema: 'vercel-backend-url-binding/v1', project_id: FRONTEND_PROJECT_ID, key: 'BACKEND_URL', target: ['preview', 'production'],
  environment_id: 'env_production_fixture', updated_at: currentTime - 300_000, encrypted_value_sha256: digest(envValue), observed_at: new Date(currentTime - 30_000).toISOString() };

function fixture({ mutatePlan = () => {}, mutateReview = () => {}, mutatePerformance = () => {}, mutateAuth = () => {}, paths = changedPaths } = {}) {
  const files = new Map();
  const put = (path, value) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); files.set(resolve(path), bytes); return bytes; };
  const attach = (path, value) => { const bytes = put(`/tmp/frontend-promotion/${path}`, value); return { path, sha256: digest(bytes) }; };
  const reviewFile = { schema: 'agentreviewaccepted/v1', ...reviewer, source_sha: frontendSha, expected_backend_source_sha: backendSha,
    reviewed_paths_sha256: digest(paths.slice().sort().join('\n')), reviewed_at: new Date(currentTime - 30_000).toISOString() };
  mutateReview(reviewFile);
  const logPath = 'performance.log';
  const log = 'performance audit passed: 187 pages, zero failures, skips, retries or flakes\n';
  const profiles = ['android-chrome', 'desktop-chrome', 'ipad-safari', 'iphone-safari'];
  const browserReport = (phase, each) => ({
    config: { projects: profiles.map(name => ({ name, retries: 0, timeout: 30000 })) }, errors: [],
    suites: [{ specs: profiles.flatMap(projectName => Array.from({ length: each }, (_, index) => ({
      file: `${phase}.spec.ts`, title: `${phase} scenario ${index}`, ok: true,
      tests: [{ projectName, expectedStatus: 'passed', status: 'expected', timeout: 30000,
        results: [{ status: 'passed', retry: 0, errors: [] }] }],
    }))), suites: [] }],
    stats: { expected: each * profiles.length, unexpected: 0, flaky: 0, skipped: 0 },
  });
  const stabilityReport = browserReport('stability', 168), performanceReport = browserReport('timing', 15);
  const bundleBudget = { budgetBytes: 576 * 1024, pages: [{ gzipKb: 440 }, { gzipKb: 510 }] };
  const artifacts = {
    stability_report: attach('stability-results.json', stabilityReport),
    performance_report: attach('performance-results.json', performanceReport),
    bundle_budget: attach('bundle-budget.json', bundleBudget),
    stability_summary: attach('stability-summary.json', { passed: 672, failures: 0, flaky: 0, skipped: 0 }),
    performance_summary: attach('performance-summary.json', { stats: performanceReport.stats, bundlePages: 2, largestInitialJsKb: 510 }),
  };
  const performanceFile = { schema: 'frontend-performance-evidence/v1', source_sha: frontendSha, command: 'npm run test:performance:audit',
    exit_code: 0, passed: true, failures: 0, skipped: 0, flakes: 0, checked_at: new Date(currentTime - 20_000).toISOString(),
    log_path: logPath, log_sha256: digest(log), artifacts };
  mutatePerformance(performanceFile);
  const plan = { schema: 'frontend-only-production-promotion/v1', team_id: FRONTEND_TEAM_ID, project_id: FRONTEND_PROJECT_ID,
    project_name: 'buildcon-house', target_domain: FRONTEND_CANONICAL_DOMAIN, candidate_url: candidateUrl,
    candidate_deployment_id: candidateId, frontend_source_sha: frontendSha, expected_backend_source_sha: backendSha,
    rollback_deployment_id: previousId, backend_url_environment: environment,
    independent_review: attach('review.json', reviewFile), performance: attach('performance.json', performanceFile),
    authorization: { owner_authorized: true, action: 'promote-frontend-only-existing-site', source_sha: frontendSha, backend_source_sha: backendSha,
      candidate_deployment_id: candidateId, rollback_deployment_id: previousId, reference: 'current-user-authorization', expires_at: new Date(currentTime + 3600_000).toISOString() } };
  mutatePlan(plan);
  put('/tmp/frontend-promotion/manifest.json', plan);
  files.set(resolve('/tmp/frontend-promotion/performance.log'), Buffer.from(log));
  files.set(resolve('/tmp/frontend-promotion/review.json'), files.get(resolve('/tmp/frontend-promotion/review.json')) || Buffer.from(JSON.stringify(reviewFile)));
  const publicReport = { base: candidateUrl, checkedAt: new Date(currentTime).toISOString(), evidence: [
    { path: '/login', status: 200 }, { path: '/api/health', status: 200 }, { path: '/api/health/ready', status: 200 },
    { path: '/api/quotations', status: 401 }, { path: '/_expo/static/js/web/entry.js', status: 200 },
    { path: '/_expo/static/js/web/missing-release-probe.js', status: 404 },
  ] };
  files.set(resolve('/tmp/frontend-promotion/public.json'), Buffer.from(JSON.stringify(publicReport)));
  const authenticatedReport = { origin: candidateUrl, sourceSha: frontendSha, checkedAt: new Date(currentTime).toISOString(), readOnly: true,
    checks: ['desktop-chrome', 'tablet-chrome', 'ipad-safari', 'iphone-safari'].flatMap(profile => [
      { profile, name: 'signed-in dashboard', passed: true }, { profile, name: 'read-only navigation', passed: true }, { profile, name: 'persistent session restore', passed: true },
    ]) };
  mutateAuth(authenticatedReport);
  files.set(resolve('/tmp/frontend-promotion/public-authenticated.json'), Buffer.from(JSON.stringify(authenticatedReport)));
  return { plan, files, read: path => { assert.ok(files.has(resolve(path)), `Fixture evidence missing: ${path}`); return files.get(resolve(path)); } };
}

function metadata(id, url, sourceSha, createdAt = currentTime - 60_000) {
  return { id, url, projectId: FRONTEND_PROJECT_ID, ownerId: FRONTEND_TEAM_ID, readyState: 'READY', target: 'production', createdAt,
    meta: { releaseSha: sourceSha } };
}

async function exercise(options = {}) {
  const { candidate = candidateUrl, failPublic = false, failAuthenticated = false, backendRevision = backendSha, backendRevisions, changed = changedPaths, fixtureOptions = {}, candidateReleaseSha = frontendSha, candidateReady = 'READY', envValueOverride = envValue, packageChange = 'allowed' } = options;
  const input = fixture({ ...fixtureOptions, paths: changed }), calls = [], promotions = [];
  let canonicalId = previousId;
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'merge-base') return { status: 0, stdout: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${options.headSha || frontendSha}\n` };
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: options.dirty ? ' M src/App.tsx\n' : '' };
    if (command === 'git' && args[0] === 'diff') return { status: 0, stdout: changed.join('\n') };
    if (command === 'git' && args[0] === 'show') {
      const before = { name: 'fixture', scripts: { 'test:unit': 'node old.mjs' }, dependencies: { react: '19' } };
      const after = structuredClone(before);
      if (packageChange === 'allowed') after.scripts['test:new'] = 'node new-test.mjs';
      if (packageChange === 'dependency') after.dependencies.react = '20';
      return { status: 0, stdout: JSON.stringify(args[1].startsWith(`${backendSha}:`) ? before : after) };
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--quiet')) return { status: 0, stdout: '' };
    if (command === 'vercel' && args[0] === 'api') {
      if (args[1].startsWith('/v10/projects/')) return { status: 0, stdout: JSON.stringify({ envs: [
        { id: environment.environment_id, key: 'BACKEND_URL', target: environment.target, updatedAt: environment.updated_at, value: envValueOverride },
      ] }) };
      if (args[1].includes(encodeURIComponent('immutable-candidate.vercel.app'))) {
        const value = metadata(candidateId, 'immutable-candidate.vercel.app', candidateReleaseSha);
        value.readyState = candidateReady;
        return { status: 0, stdout: JSON.stringify(value) };
      }
      if (args[1].includes(encodeURIComponent(FRONTEND_CANONICAL_DOMAIN))) {
        const id = canonicalId;
        return { status: 0, stdout: JSON.stringify(metadata(id, id === candidateId ? 'immutable-candidate.vercel.app' : 'previous.vercel.app', id === candidateId ? frontendSha : previousSha)) };
      }
    }
    if (command.endsWith('node') && args.some(value => String(value).endsWith('verify-production-release.mjs'))) return { status: failPublic ? 1 : 0, stdout: '' };
    if (command.endsWith('node') && args.some(value => String(value).endsWith('verify-authenticated-release.mjs'))) return { status: failAuthenticated ? 1 : 0, stdout: '' };
    if (command === 'vercel' && args[0] === 'promote') { promotions.push(args[1]); canonicalId = args[1]; return { status: 0, stdout: '' }; }
    return { status: 0, stdout: '' };
  };
  let fetchCount = 0;
  const fetchImpl = async inputUrl => {
    const revisions = backendRevisions || [backendRevision];
    const source_revision = revisions[Math.min(fetchCount++, revisions.length - 1)];
    return new Response(JSON.stringify({ status: 'ok', source_revision }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const read = path => input.files.has(resolve(path)) ? input.read(path) : readFileSync(path);
  let result, error;
  try {
    result = await promoteVerifiedFrontend({ candidate, frontendSha, backendSha, manifestPath: '/tmp/frontend-promotion/manifest.json',
      report: '/tmp/frontend-promotion/public.json', read, run, fetchImpl, now: () => currentTime,
      write: () => {} });
  } catch (value) { error = value; }
  return { input, calls, promotions, result, error };
}

const loaded = fixture();
const valid = loadFrontendPromotionPackage({ manifestPath: '/tmp/frontend-promotion/manifest.json', candidate: candidateUrl,
  frontendSha, backendSha, read: loaded.read, run: (command, args) => command === 'git' && args[0] === 'merge-base'
    ? { status: 0, stdout: '' } : { status: 0, stdout: changedPaths.join('\n') }, now: currentTime });
assert.equal(valid.plan.frontend_source_sha, frontendSha);
assert.equal(valid.plan.expected_backend_source_sha, backendSha);

const promoted = await exercise();
assert.equal(promoted.error, undefined);
assert.deepEqual(promoted.promotions, [candidateId]);
assert.equal(promoted.result.frontend_source_sha, frontendSha);
assert.equal(promoted.result.backend_source_sha, backendSha);
assert.equal(promoted.result.backend_source_before, backendSha);
assert.equal(promoted.result.backend_source_candidate, backendSha);
assert.equal(promoted.result.backend_source_after, backendSha);
assert.deepEqual(promoted.result.authenticated_profiles, ['desktop-chrome', 'tablet-chrome', 'ipad-safari', 'iphone-safari']);

for (const options of [
  { candidate: 'https://other.vercel.app' },
  { candidateReleaseSha: 'd'.repeat(40) },
  { candidateReady: 'BUILDING' },
  { envValueOverride: 'changed-encrypted-value' },
  { headSha: 'f'.repeat(40) },
  { dirty: true },
  { fixtureOptions: { mutatePlan: plan => { plan.frontend_source_sha = 'd'.repeat(40); } } },
  { fixtureOptions: { mutateReview: review => { review.accepted = false; } } },
  { fixtureOptions: { mutateReview: review => { review.source_sha = 'e'.repeat(40); } } },
  { fixtureOptions: { mutatePerformance: performance => { performance.skipped = 1; } } },
  { fixtureOptions: { mutatePerformance: performance => { performance.artifacts.stability_report.sha256 = '0'.repeat(64); } } },
  { fixtureOptions: { mutatePerformance: performance => { performance.artifacts.bundle_budget = undefined; } } },
  { fixtureOptions: { mutatePerformance: performance => { performance.artifacts.bundle_budget = { path: 'bundle-budget.json', sha256: digest(JSON.stringify({ budgetBytes: 576 * 1024, pages: [{ gzipKb: 577 }] })) }; } } },
  { fixtureOptions: { mutateAuth: report => { report.checks = report.checks.filter(check => check.profile !== 'tablet-chrome'); } } },
  { changed: ['backend/server.py'] },
  { changed: ['app/(admin)/kitchen/index.tsx'] },
  { changed: ['src/api/kitchenProjects.ts'] },
  { changed: ['.github/workflows/deploy.yml'] },
  { changed: ['vercel.json'] },
  { changed: ['src/security/contentPolicy.ts'] },
  { changed: ['scripts/verify-production-release.mjs'] },
  { changed: ['package.json'], packageChange: 'dependency' },
]) {
  const result = await exercise(options);
  assert.ok(result.error, 'Missing, changed or out-of-scope evidence/source must fail closed');
  assert.deepEqual(result.promotions, [], 'Insufficient local evidence must fail before any promotion');
  assert.equal(result.calls.some(call => call.command === 'vercel' && call.args[0] === 'promote'), false);
}

const packageScriptsOnly = await exercise({ changed: [...changedPaths, 'package.json'] });
assert.equal(packageScriptsOnly.error, undefined, 'Test-only package script metadata may accompany a frontend release');
assert.deepEqual(packageScriptsOnly.promotions, [candidateId]);

assert.throws(() => loadFrontendPromotionPackage({ manifestPath: '/tmp/frontend-promotion/manifest.json', candidate: candidateUrl,
  frontendSha: '', backendSha, read: loaded.read, run: () => { throw new Error('Diff must not run without source SHA'); }, now: currentTime }));

for (const options of [
  { failPublic: true },
  { failAuthenticated: true },
  { backendRevision: previousSha },
  { backendRevisions: [backendSha, previousSha] },
]) {
  const result = await exercise(options);
  assert.ok(result.error);
  assert.deepEqual(result.promotions, [], 'A public-check or source-identity failure must stop promotion');
}

const postPromotionDrift = await exercise({ backendRevisions: [backendSha, backendSha, previousSha] });
assert.match(postPromotionDrift.error?.message || '', /previous frontend deployment was restored/);
assert.deepEqual(postPromotionDrift.promotions, [candidateId, previousId], 'Failed post-promotion identity check must restore the exact previous frontend');

console.log('Frontend-only promotion guard: source/path, review, performance, authenticated viewport, candidate, environment, readiness and public-check failures block promotion. Synthetic evidence only; no provider calls made.');
