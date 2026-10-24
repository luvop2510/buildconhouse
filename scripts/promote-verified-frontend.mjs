import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyBrowserEvidence } from './run-performance-audit.mjs';

export const FRONTEND_TEAM_ID = 'team_TNMtYYjniBWtCj1l58NEFSPG';
export const FRONTEND_PROJECT_ID = 'prj_RuZWSvov1AkP2UDmWaea6925wWlU';
export const FRONTEND_PROJECT_NAME = 'buildcon-house';
export const FRONTEND_CANONICAL_DOMAIN = 'buildconhouse.in';
export const FRONTEND_MANIFEST_SCHEMA = 'frontend-only-production-promotion/v1';

const sha40 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fresh = (value, label, now) => {
  const at = Date.parse(value);
  assert.ok(Number.isFinite(at) && at <= now + 60_000 && now - at <= 3_600_000, `${label} must be measured within the last hour`);
};
const reviewer = value => {
  assert.equal(value?.accepted, true, 'Independent agent review must be accepted');
  assert.equal(value?.independent, true, 'Frontend release needs independent review');
  assert.match(value?.reviewer || '', /\S/, 'Independent reviewer identity is required');
  assert.match(value?.reference || '', /\S/, 'Independent review reference is required');
};

export function immutableCandidate(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', 'Candidate must use HTTPS');
  assert.ok(url.hostname.endsWith('.vercel.app'), 'Candidate must be an immutable Vercel deployment URL');
  assert.equal(url.username, ''); assert.equal(url.password, '');
  assert.equal(url.pathname, '/'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.notEqual(url.hostname, FRONTEND_CANONICAL_DOMAIN, 'Promotion must use the immutable candidate URL');
  return url;
}

function readHashedArtifact(manifestPath, descriptor, read) {
  assert.ok(descriptor?.path, 'Missing hashed release evidence');
  assert.match(descriptor.sha256 || '', sha256, 'Malformed release evidence hash');
  const bytes = read(evidencePath(manifestPath, descriptor.path));
  assert.equal(hash(bytes), descriptor.sha256, 'Release evidence changed after review');
  return JSON.parse(bytes.toString());
}

function readPerformanceEvidence(manifestPath, descriptor, read) {
  assert.ok(descriptor?.path, 'Missing hashed performance evidence');
  assert.match(descriptor.sha256 || '', sha256, 'Malformed performance evidence hash');
  const bytes = read(evidencePath(manifestPath, descriptor.path));
  assert.equal(hash(bytes), descriptor.sha256, 'Performance evidence changed after review');
  return JSON.parse(bytes.toString());
}

function validatePerformanceArtifacts(manifestPath, performance, read) {
  const artifacts = performance.artifacts;
  assert.ok(artifacts && typeof artifacts === 'object', 'Hashed browser reports and budgets are required');
  for (const name of ['stability_report', 'performance_report', 'bundle_budget', 'stability_summary', 'performance_summary']) {
    assert.ok(artifacts[name], `Missing ${name} performance artifact`);
  }
  const values = Object.fromEntries(Object.entries(artifacts).map(([name, descriptor]) => [name,
    readPerformanceEvidence(manifestPath, descriptor, read)]));
  assert.equal(verifyBrowserEvidence(values.stability_report, 'stability'), 676,
    'All 676 current stability scenarios must be present');
  assert.equal(verifyBrowserEvidence(values.performance_report, 'timing'), 60,
    'All 60 current timing scenarios must be present');
  const pages = values.bundle_budget.pages;
  assert.equal(values.bundle_budget.budgetBytes, 576 * 1024, 'The initial JavaScript release budget changed');
  assert.ok(Array.isArray(pages) && pages.length > 0, 'Bundle budget evidence has no exported pages');
  for (const page of pages) assert.ok(Number.isFinite(page.gzipKb) && page.gzipKb >= 0 && page.gzipKb <= 576,
    'An exported page exceeds the 576 KiB initial JavaScript budget');
  const timingStats = values.performance_report.stats;
  assert.equal(values.performance_summary.stats?.expected, timingStats.expected);
  assert.ok(values.performance_summary.stats.expected >= 40, 'Performance summary is below the release minimum');
  assert.equal(values.performance_summary.stats?.unexpected, 0);
  assert.equal(values.performance_summary.stats?.flaky, 0);
  assert.equal(values.performance_summary.stats?.skipped, 0);
  assert.equal(values.performance_summary.bundlePages, pages.length);
  assert.equal(values.performance_summary.largestInitialJsKb, Math.max(...pages.map(page => page.gzipKb)));
  assert.equal(values.stability_summary.passed, 676);
  assert.equal(values.stability_summary.failures, 0);
  assert.equal(values.stability_summary.flaky, 0);
  assert.equal(values.stability_summary.skipped, 0);
}

function assertReleaseCheckout(frontendSha, run) {
  const head = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(head.status, 0, 'Cannot identify current release source');
  assert.equal(head.stdout.trim(), frontendSha, 'Current checkout HEAD differs from the reviewed frontend source');
  const status = run('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  assert.equal(status.status, 0, 'Cannot verify release checkout cleanliness');
  assert.equal(status.stdout.trim(), '', 'Tracked working-tree changes prevent promotion');
}

function evidencePath(manifestPath, name) {
  assert.ok(typeof name === 'string' && name.length > 0, 'Missing evidence file path');
  const root = resolve(dirname(manifestPath)), path = resolve(root, name), rel = relative(root, path);
  assert.ok(path !== root && !rel.startsWith(`..${sep}`) && rel !== '..', 'Evidence paths must stay inside the release evidence directory');
  return path;
}

function validateChangedPaths({ frontendSha, backendSha, run }) {
  assert.match(frontendSha || '', sha40, 'Complete frontend source SHA is required');
  assert.match(backendSha || '', sha40, 'Complete expected backend source SHA is required');
  const ancestor = run('git', ['merge-base', '--is-ancestor', backendSha, frontendSha], { encoding: 'utf8' });
  assert.equal(ancestor.status, 0, 'Expected live backend source must be an ancestor of the frontend release');
  const result = run('git', ['diff', '--name-only', `${backendSha}..${frontendSha}`, '--'], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'Cannot inspect frontend release changes');
  const paths = result.stdout.split(/\r?\n/).filter(Boolean).sort();
  const runtimeStartupPaths = new Set([
    'src/components/AuthGate.tsx', 'src/state/auth.tsx', 'src/hooks/use-floor-access.ts', 'src/hooks/use-floor-access.web.ts',
    'src/components/BackendServerStatus.tsx', 'src/components/StartupScreen.tsx',
    'src/lib/backend-startup-controller.ts', 'src/lib/backend-startup.web.ts', 'src/lib/backend-startup.ts',
    'app/_layout.web.tsx', 'app/(admin)/_layout.tsx', 'app/(customer)/_layout.tsx', 'src/hooks/use-permissions.ts', 'src/design/CommandPalette.tsx',
  ]);
  const securitySensitive = path => !runtimeStartupPaths.has(path) &&
    /(^|\/)(?:auth|security|permissions?|csrf|sessions?)(?:\/|\.|$)|(?:cookie|csp|content-security|access-control)/i.test(path);
  if (paths.includes('package.json')) {
    const previous = run('git', ['show', `${backendSha}:package.json`], { encoding: 'utf8' });
    const current = run('git', ['show', `${frontendSha}:package.json`], { encoding: 'utf8' });
    assert.equal(previous.status, 0); assert.equal(current.status, 0, 'Cannot inspect package metadata changes');
    const before = JSON.parse(previous.stdout), after = JSON.parse(current.stdout);
    const beforeRest = { ...before }, afterRest = { ...after };
    delete beforeRest.scripts; delete afterRest.scripts;
    assert.deepEqual(afterRest, beforeRest, 'Only package test/verification script metadata may change');
    const beforeScripts = before.scripts || {}, afterScripts = after.scripts || {};
    const scriptNames = [...new Set([...Object.keys(beforeScripts), ...Object.keys(afterScripts)])];
    for (const name of scriptNames) {
      if (beforeScripts[name] !== afterScripts[name]) assert.match(name, /^(?:test|verify):/, 'Only test/verification script entries may change');
    }
  }
  const forbidden = paths.filter(path => !(
    runtimeStartupPaths.has(path) || path.startsWith('e2e/') ||
    path.startsWith('docs/') || path === 'AGENTS.md' ||
    path === 'api/[...path].js' || path === 'package.json' ||
    path === 'playwright.stability.config.ts' ||
    path === 'scripts/stability-routes.ts' ||
    path === 'scripts/web-worker.mjs' ||
    path === 'scripts/sites-build.mjs' ||
    path === 'scripts/isolate-web-module-graph.mjs' ||
    path === 'scripts/release-recovery.js' ||
    path === 'scripts/verify-authenticated-release.mjs' ||
    path === 'scripts/promote-verified-frontend.mjs' ||
    path === 'scripts/test-frontend-promotion.mjs' ||
    /^scripts\/test-[a-z0-9-]+\.mjs$/.test(path)
  ) || securitySensitive(path));
  assert.deepEqual(forbidden, [], `Frontend-only release contains disallowed paths: ${forbidden.join(', ')}`);
  assert.ok(paths.length > 0, 'Frontend release diff is empty');
  assert.equal(paths.some(path => path === 'backend' || path.startsWith('backend/')), false, 'Backend changes require a backend publication');
  return paths;
}

export function loadFrontendPromotionPackage({ manifestPath, candidate, frontendSha, backendSha, read = readFileSync, run = spawnSync, now = Date.now() }) {
  const candidateUrl = immutableCandidate(candidate);
  const plan = JSON.parse(read(manifestPath).toString());
  assert.equal(plan.schema, FRONTEND_MANIFEST_SCHEMA);
  assert.equal(plan.team_id, FRONTEND_TEAM_ID);
  assert.equal(plan.project_id, FRONTEND_PROJECT_ID);
  assert.equal(plan.project_name, FRONTEND_PROJECT_NAME);
  assert.equal(plan.target_domain, FRONTEND_CANONICAL_DOMAIN);
  assert.equal(new URL(plan.candidate_url).origin, candidateUrl.origin);
  assert.equal(plan.frontend_source_sha, frontendSha);
  assert.equal(plan.expected_backend_source_sha, backendSha);
  assert.match(frontendSha || '', sha40, 'Complete frontend source SHA is required');
  assert.match(backendSha || '', sha40, 'Complete expected backend source SHA is required');

  const changedPaths = validateChangedPaths({ frontendSha, backendSha, run });
  const pathDigest = hash(changedPaths.join('\n'));

  const review = readHashedArtifact(manifestPath, plan.independent_review, read);
  reviewer(review);
  assert.equal(review.schema, 'agentreviewaccepted/v1');
  assert.equal(review.source_sha, frontendSha);
  assert.equal(review.expected_backend_source_sha, backendSha);
  assert.equal(review.reviewed_paths_sha256, pathDigest, 'Independent review did not cover the exact frontend-only diff');
  fresh(review.reviewed_at, 'Independent review', now);

  const performance = readHashedArtifact(manifestPath, plan.performance, read);
  assert.equal(performance.schema, 'frontend-performance-evidence/v1');
  assert.equal(performance.source_sha, frontendSha);
  assert.equal(performance.command, 'npm run test:performance:audit');
  assert.equal(performance.exit_code, 0);
  assert.equal(performance.passed, true);
  assert.equal(performance.failures, 0); assert.equal(performance.skipped, 0); assert.equal(performance.flakes, 0);
  fresh(performance.checked_at, 'Performance audit', now);
  assert.match(performance.log_sha256 || '', sha256, 'Performance audit log must be content-hashed');
  const performanceLog = read(evidencePath(manifestPath, performance.log_path));
  assert.equal(hash(performanceLog), performance.log_sha256, 'Performance audit log hash does not match');
  validatePerformanceArtifacts(manifestPath, performance, read);

  const authorization = plan.authorization;
  assert.equal(authorization?.owner_authorized, true, 'Explicit owner authorization is required');
  assert.equal(authorization?.action, 'promote-frontend-only-existing-site');
  assert.equal(authorization?.source_sha, frontendSha);
  assert.equal(authorization?.backend_source_sha, backendSha);
  assert.equal(authorization?.candidate_deployment_id, plan.candidate_deployment_id);
  assert.equal(authorization?.rollback_deployment_id, plan.rollback_deployment_id);
  assert.notEqual(plan.rollback_deployment_id, plan.candidate_deployment_id);
  assert.equal(plan.canonical_alias?.schema, 'vercel-canonical-alias/v1');
  assert.equal(plan.canonical_alias?.alias, FRONTEND_CANONICAL_DOMAIN);
  assert.equal(plan.canonical_alias?.project_id, FRONTEND_PROJECT_ID);
  assert.equal(plan.canonical_alias?.deployment_id, plan.rollback_deployment_id);
  assert.ok(Number.isFinite(plan.canonical_alias?.updated_at), 'Canonical alias update timestamp must be pinned');
  assert.match(authorization?.reference || '', /\S/);
  assert.ok(Date.parse(authorization?.expires_at) > now, 'Owner authorization is expired');

  const environment = plan.backend_url_environment;
  assert.equal(environment?.schema, 'vercel-backend-url-binding/v1');
  assert.equal(environment?.project_id, FRONTEND_PROJECT_ID);
  assert.equal(environment?.key, 'BACKEND_URL');
  assert.ok(Array.isArray(environment?.target) && environment.target.includes('production'));
  assert.deepEqual(environment.target, [...new Set(environment.target)].sort(), 'BACKEND_URL targets must be unique and sorted');
  assert.match(environment?.environment_id || '', /\S/);
  assert.match(environment?.encrypted_value_sha256 || '', sha256);
  assert.ok(Number.isFinite(environment?.updated_at), 'Production BACKEND_URL updatedAt must be pinned');
  fresh(environment.observed_at, 'Vercel BACKEND_URL settings observation', now);

  return { plan, candidateUrl, changedPaths, review, performance, environment };
}

function parseJsonResult(result, label) {
  assert.equal(result.status, 0, `${label} failed`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${label} returned invalid metadata`); }
}

function deploymentMetadata(run, target) {
  const endpoint = `/v13/deployments/${encodeURIComponent(target)}?teamId=${FRONTEND_TEAM_ID}`;
  return parseJsonResult(run(process.env.FORGE_VERCEL_CLI || 'vercel', ['api', endpoint, '--method', 'GET'], { encoding: 'utf8' }), `Vercel ${target} metadata read`);
}

function canonicalAliasMetadata(run) {
  const endpoint = `/v4/aliases/${encodeURIComponent(FRONTEND_CANONICAL_DOMAIN)}?teamId=${FRONTEND_TEAM_ID}`;
  const alias = parseJsonResult(run(process.env.FORGE_VERCEL_CLI || 'vercel', ['api', endpoint, '--method', 'GET'], { encoding: 'utf8' }), 'Vercel canonical alias read');
  assert.equal(alias.alias, FRONTEND_CANONICAL_DOMAIN, 'Vercel returned another alias');
  assert.equal(alias.deletedAt, null, 'Canonical alias has been deleted');
  assert.equal(alias.projectId, FRONTEND_PROJECT_ID, 'Canonical alias belongs to another Vercel project');
  assert.match(alias.deploymentId || '', /\S/, 'Canonical alias has no deployment identity');
  assert.equal(alias.deployment?.id, alias.deploymentId, 'Canonical alias deployment identity is inconsistent');
  assert.match(alias.deployment?.url || '', /\.vercel\.app$/, 'Canonical alias has no immutable deployment URL');
  assert.ok(Number.isFinite(alias.updatedAt), 'Canonical alias update timestamp is missing');
  const deployment = deploymentMetadata(run, alias.deploymentId);
  assert.equal(deployment.id, alias.deploymentId, 'Vercel alias resolved to another deployment');
  assert.equal(deployment.projectId, FRONTEND_PROJECT_ID, 'Canonical deployment belongs to another Vercel project');
  assert.equal(deployment.ownerId, FRONTEND_TEAM_ID, 'Canonical deployment belongs to another Vercel team');
  assert.equal(alias.deployment.url, deployment.url, 'Canonical alias URL does not match its deployment metadata');
  return { ...deployment, canonicalAlias: {
    alias: alias.alias, projectId: alias.projectId, deploymentId: alias.deploymentId,
    deploymentUrl: alias.deployment.url, updatedAt: alias.updatedAt,
  } };
}

function productionBackendUrlEnvironment(run) {
  const endpoint = `/v10/projects/${FRONTEND_PROJECT_ID}/env?teamId=${FRONTEND_TEAM_ID}`;
  const payload = parseJsonResult(run(process.env.FORGE_VERCEL_CLI || 'vercel', ['api', endpoint, '--method', 'GET'], { encoding: 'utf8' }), 'Vercel project environment read');
  const matches = (payload.envs || []).filter(row => row.key === 'BACKEND_URL' && Array.isArray(row.target) && row.target.includes('production'));
  assert.equal(matches.length, 1, 'Project must have exactly one production BACKEND_URL setting');
  const [row] = matches;
  const target = [...new Set(row.target)].sort();
  const value = String(row.value || '');
  assert.ok(value.length > 0, 'Production BACKEND_URL is not configured');
  return { id: row.id, target, updatedAt: row.updatedAt, encryptedValueSha256: hash(value) };
}

async function readBackendRevision(origin, { candidate = false, fetchImpl = fetch, bypass = '' } = {}) {
  const headers = candidate && bypass ? { 'x-vercel-protection-bypass': bypass } : {};
  const response = await fetchImpl(new URL('/api/health/ready', origin), { headers, redirect: 'error', signal: AbortSignal.timeout(25_000) });
  assert.equal(response.status, 200, `${origin}: backend readiness is unavailable`);
  const body = await response.json();
  assert.equal(body.status, 'ok', `${origin}: backend is not ready`);
  assert.match(body.source_revision || '', sha40, `${origin}: backend did not report a pinned source revision`);
  return body.source_revision;
}

function validatePublicReport(report, origin) {
  assert.equal(new URL(report.base).origin, origin);
  assert.ok(Array.isArray(report.evidence) && report.evidence.length > 0, 'Public API/assets report is empty');
  const statuses = new Map(report.evidence.map(row => [row.path, row.status]));
  for (const path of ['/login', '/api/health', '/api/health/ready']) assert.equal(statuses.get(path), 200, `Public check missing/success status: ${path}`);
  assert.equal(statuses.get('/api/quotations'), 401, 'Anonymous API access must remain protected');
  assert.ok([...statuses].some(([path, status]) => path.startsWith('/_expo/static/js/web/') && status === 200), 'No verified Expo JavaScript asset');
  assert.ok([...statuses].some(([path, status]) => path.includes('missing-release-probe') && status === 404), 'Missing assets must remain 404');
}

function validateAuthenticatedReport(report, origin, frontendSha, now) {
  assert.equal(new URL(report.origin).origin, origin);
  assert.equal(report.sourceSha, frontendSha);
  assert.equal(report.readOnly, true);
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 10 && report.checks.every(check => check.passed === true), 'Authenticated viewport verification is incomplete');
  const profiles = new Set(report.checks.map(check => check.profile));
  for (const profile of ['desktop-chrome', 'tablet-chrome', 'ipad-safari', 'iphone-safari']) assert.ok(profiles.has(profile), `Authenticated ${profile} check is missing`);
  fresh(report.checkedAt, 'Authenticated desktop/tablet/mobile verification', now);
}

function assertVerifierBlocksWrites(frontendSha, run, read) {
  const path = 'scripts/verify-authenticated-release.mjs';
  const unchanged = run('git', ['diff', '--quiet', frontendSha, '--', path], { encoding: 'utf8' });
  assert.equal(unchanged.status, 0, 'Authenticated verifier working-tree source differs from the release commit');
  const source = read(resolve(path)).toString();
  assert.match(source, /!\[['"]GET['"],\s*['"]HEAD['"],\s*['"]OPTIONS['"]\]\.includes\(request\.method\(\)\)/,
    'Authenticated verifier must block unsafe same-origin API requests');
  assert.match(source, /route\.abort\(['"]blockedbyclient['"]\)/, 'Authenticated verifier must abort unsafe requests before transmission');
}

export async function promoteVerifiedFrontend({
  candidate, frontendSha, backendSha, manifestPath = process.env.FORGE_FRONTEND_PROMOTION_MANIFEST,
  report = 'output/frontend-promotion/public-assets.json', read = readFileSync, write = writeFileSync,
  run = spawnSync, fetchImpl = fetch, now = Date.now,
} = {}) {
  const prepared = loadFrontendPromotionPackage({ manifestPath, candidate, frontendSha, backendSha, read, run, now: now() });
  assert.equal(prepared.plan.candidate_deployment_id, prepared.plan.authorization.candidate_deployment_id);
  assertReleaseCheckout(frontendSha, run);

  const candidateDeployment = deploymentMetadata(run, prepared.candidateUrl.hostname);
  assert.equal(candidateDeployment.projectId, FRONTEND_PROJECT_ID, 'Candidate belongs to another Vercel project');
  assert.equal(candidateDeployment.ownerId, FRONTEND_TEAM_ID, 'Candidate belongs to another Vercel team');
  assert.equal(candidateDeployment.readyState, 'READY', 'Candidate is not READY');
  assert.equal(candidateDeployment.target, 'production', 'Candidate must be built with production settings');
  assert.equal(candidateDeployment.url, prepared.candidateUrl.hostname, 'Mutable aliases cannot identify the tested artifact');
  assert.equal(candidateDeployment.id, prepared.plan.candidate_deployment_id);
  assert.equal(candidateDeployment.meta?.releaseSha, frontendSha, 'Candidate source differs from reviewed source');
  assert.ok(Number.isFinite(candidateDeployment.createdAt), 'Candidate creation time is missing');

  const canonicalBefore = canonicalAliasMetadata(run);
  assert.equal(canonicalBefore.readyState, 'READY', 'Current canonical rollback target is not ready');
  assert.equal(canonicalBefore.target, 'production', 'Current canonical rollback target is not production');
  assert.equal(canonicalBefore.id, prepared.plan.rollback_deployment_id, 'Canonical domain rollback target changed after review');
  assert.equal(canonicalBefore.canonicalAlias.updatedAt, prepared.plan.canonical_alias.updated_at, 'Canonical alias changed after rollback review');
  assert.notEqual(canonicalBefore.id, candidateDeployment.id, 'Candidate is already promoted');

  const environment = productionBackendUrlEnvironment(run);
  assert.equal(environment.id, prepared.environment.environment_id, 'Production BACKEND_URL setting identity changed');
  assert.deepEqual(environment.target, prepared.environment.target, 'Production BACKEND_URL targets changed');
  assert.equal(environment.encryptedValueSha256, prepared.environment.encrypted_value_sha256, 'Production BACKEND_URL value changed');
  assert.equal(environment.updatedAt, prepared.environment.updated_at, 'Production BACKEND_URL was edited after evidence capture');
  assert.ok(environment.updatedAt <= candidateDeployment.createdAt, 'Candidate was built before the pinned BACKEND_URL setting');

  const canonicalBackendBefore = await readBackendRevision(`https://${FRONTEND_CANONICAL_DOMAIN}`, { fetchImpl });
  assert.equal(canonicalBackendBefore, backendSha, 'Canonical domain no longer serves the pinned backend source');
  const candidateBackend = await readBackendRevision(prepared.candidateUrl.origin, { candidate: true, fetchImpl, bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '' });
  assert.equal(candidateBackend, backendSha, 'Candidate routes to another backend source');

  const publicReportPath = resolve(report);
  const publicCheck = run(process.execPath, [fileURLToPath(new URL('./verify-production-release.mjs', import.meta.url)), prepared.candidateUrl.origin, publicReportPath], { stdio: 'inherit' });
  assert.equal(publicCheck.status, 0, 'Candidate public API/assets verification failed; promotion stopped');
  const publicReport = JSON.parse(read(publicReportPath).toString());
  validatePublicReport(publicReport, prepared.candidateUrl.origin);
  fresh(publicReport.checkedAt, 'Public API/assets verification', now());

  assertVerifierBlocksWrites(frontendSha, run, read);
  const authenticatedReportPath = publicReportPath.replace(/\.json$/, '-authenticated.json');
  const authenticatedCheck = run(process.execPath, [fileURLToPath(new URL('./verify-authenticated-release.mjs', import.meta.url)),
    prepared.candidateUrl.origin, frontendSha, authenticatedReportPath], { stdio: 'inherit' });
  assert.equal(authenticatedCheck.status, 0, 'Authenticated desktop/tablet/mobile verification failed; promotion stopped');
  const authenticatedReportBytes = read(authenticatedReportPath);
  const authenticatedReport = JSON.parse(authenticatedReportBytes.toString());
  validateAuthenticatedReport(authenticatedReport, prepared.candidateUrl.origin, frontendSha, now());

  assertReleaseCheckout(frontendSha, run);
  const promoter = process.env.FORGE_VERCEL_CLI || 'vercel';
  const result = run(promoter, ['promote', candidateDeployment.id, '--yes', '--scope', FRONTEND_TEAM_ID], { stdio: 'inherit' });
  assert.equal(result.status, 0, 'Vercel canonical-domain promotion failed');

  let canonicalBackendAfter;
  try {
    const canonicalAfter = canonicalAliasMetadata(run);
    assert.equal(canonicalAfter.projectId, FRONTEND_PROJECT_ID);
    assert.equal(canonicalAfter.readyState, 'READY');
    assert.equal(canonicalAfter.target, 'production');
    assert.equal(canonicalAfter.id, candidateDeployment.id, 'Canonical domain does not point to the reviewed frontend candidate');
    assert.equal(canonicalAfter.meta?.releaseSha, frontendSha);
    canonicalBackendAfter = await readBackendRevision(`https://${FRONTEND_CANONICAL_DOMAIN}`, { fetchImpl });
    assert.equal(canonicalBackendAfter, backendSha, 'Canonical promotion changed or disconnected the pinned backend');
  } catch {
    const rollback = run(promoter, ['promote', canonicalBefore.id, '--yes', '--scope', FRONTEND_TEAM_ID], { stdio: 'inherit' });
    assert.equal(rollback.status, 0, 'Post-promotion qualification failed and the prior frontend could not be restored');
    const restored = canonicalAliasMetadata(run);
    assert.equal(restored.id, canonicalBefore.id, 'Post-promotion qualification failed and rollback target is not live');
    throw new Error('Canonical post-promotion qualification failed; the previous frontend deployment was restored.');
  }

  const receipt = {
    schema: 'frontend-only-promotion-receipt/v1',
    promoted_at: new Date(now()).toISOString(),
    team_id: FRONTEND_TEAM_ID, project_id: FRONTEND_PROJECT_ID, domain: FRONTEND_CANONICAL_DOMAIN,
    deployment_id: candidateDeployment.id, frontend_source_sha: frontendSha, backend_source_sha: backendSha,
    previous_deployment_id: canonicalBefore.id,
    previous_alias_updated_at: canonicalBefore.canonicalAlias.updatedAt,
    changed_paths_sha256: hash(prepared.changedPaths.join('\n')),
    performance_evidence_sha256: prepared.plan.performance.sha256,
    authenticated_report_sha256: hash(authenticatedReportBytes),
    authenticated_profiles: ['desktop-chrome', 'tablet-chrome', 'ipad-safari', 'iphone-safari'],
    public_report_path: publicReportPath,
    public_report_sha256: hash(read(publicReportPath)),
    backend_source_before: canonicalBackendBefore, backend_source_candidate: candidateBackend, backend_source_after: canonicalBackendAfter,
  };
  if (report) write(report.replace(/\.json$/, '-promotion.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [candidate, frontendSha, backendSha, report] = process.argv.slice(2);
  const receipt = await promoteVerifiedFrontend({ candidate, frontendSha, backendSha, report });
  console.log(`Frontend-only promotion verified: ${receipt.deployment_id}; backend source ${receipt.backend_source_sha} unchanged.`);
}
