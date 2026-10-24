// Existing-site qualification uses reviewed provider evidence and a fresh
// read-only observation inside the exact deployed Railway service container.
// Only this run's real login/logout may write; no business mutation is allowed.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { captureRuntimeHealth } from '../e2e/runtime-health.ts';
import { assertPersistentCookies } from './verify-release-cookies.mjs';
import { canonicalCandidate, loadKitchenPromotionPackage, validateRunningObservation, validateReleaseException, RAILWAY_TARGET, RUNTIME_ROOT_FILES, RUNTIME_DIRECTORIES } from './promote-verified-vercel.mjs';

const readPaths = new Set(['/api/health', '/api/health/ready', '/api/auth/me', '/api/kitchen-projects/configuration', '/api/kitchen-projects/dashboard', '/api/kitchen-projects?limit=1']);
export async function productionRequest(context, origin, headers, method, path, data) {
  assert.ok((method === 'GET' && readPaths.has(path)) || (method === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(path)), 'Production business writes/unknown probes are forbidden');
  assert.equal(new URL(path, origin).origin, origin);
  return context.request.fetch(origin + path, { method, headers, maxRedirects: 0, timeout: 25000, ...(data ? { data } : {}) });
}
export function productionBrowserRoute(origin, bypass, onBlocked) {
  return async route => {
    const request = route.request(), target = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { onBlocked(); return route.abort('blockedbyclient'); }
    const headers = { ...request.headers() };
    delete headers['x-vercel-protection-bypass'];
    if (target.origin !== origin) return route.continue({ headers });
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;
    // Browser route.continue header overrides can survive redirects, whose
    // destination does not necessarily invoke this route again. Fetch once,
    // reject redirects, then fulfill without installing inherited headers.
    const response = await route.fetch({ headers, maxRedirects: 0, timeout: 25000 });
    if (response.status() >= 300 && response.status() < 400) { onBlocked(); return route.abort('blockedbyclient'); }
    return route.fulfill({ response });
  };
}
// This constant is passed as argv to SSH, never interpolated into a local shell.
// It reads allowlisted packaged code, hashes credential-free identities, pings
// Mongo, reads pending migrations and checks private bucket visibility. No app
// lifespan, migration, policy change, backup write or business mutation runs.
export const RUNNING_SERVICE_PROBE = `
import asyncio, hashlib, json, os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
ROOT_FILES = ${JSON.stringify(RUNTIME_ROOT_FILES)}
DIRECTORIES = ${JSON.stringify(RUNTIME_DIRECTORIES)}
def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
async def main():
    from settings import settings
    from db import db, client
    from migrations.runner import pending_migrations
    from media_storage.factory import get_media_storage
    root = Path('/app').resolve()
    files = {}
    for entry in ROOT_FILES + DIRECTORIES:
        path = root / entry
        paths = path.rglob('*') if path.is_dir() else [path]
        for item in paths:
            if not item.is_file() or '__pycache__' in item.parts or item.suffix == '.pyc':
                continue
            if item.is_symlink() or root not in item.resolve().parents:
                raise ValueError('unexpected_runtime_path')
            files[str(item.relative_to(root))] = hashlib.sha256(item.read_bytes()).hexdigest()
    mongo = urlsplit(settings.mongo_url)
    hosts = mongo.netloc.rsplit('@', 1)[-1].lower()
    database_fingerprint = digest({'scheme': mongo.scheme, 'hosts': hosts, 'database': settings.db_name})
    driver = settings.media_storage_driver
    storage_origin = ('https://' + os.environ.get('R2_ACCOUNT_ID', '') + '.r2.cloudflarestorage.com') if driver == 'r2' else str(settings.supabase_url).rstrip('/')
    private_storage_fingerprint = digest({'driver': driver, 'origin': storage_origin, 'private_bucket': settings.supabase_private_bucket})
    try:
        await db.command('ping')
        pending = await pending_migrations(db)
        await get_media_storage().require_private_bucket(settings.supabase_private_bucket)
        print(json.dumps({'schema': 'kitchen-running-service-observation/v1', 'method': 'railway-ssh-readonly',
            'observed_at': datetime.now(timezone.utc).isoformat(),
            'project_id': os.environ.get('RAILWAY_PROJECT_ID'), 'environment_id': os.environ.get('RAILWAY_ENVIRONMENT_ID'),
            'service_id': os.environ.get('RAILWAY_SERVICE_ID'), 'deployment_id': os.environ.get('RAILWAY_DEPLOYMENT_ID'),
            'files': files, 'database_fingerprint': database_fingerprint, 'private_storage_fingerprint': private_storage_fingerprint,
            'mongo_ping': True, 'private_bucket_verified': True, 'pending_migrations': pending,
            'kitchen_owner_only': os.environ.get('FORGE_KITCHEN_OWNER_ONLY', 'false').lower() == 'true'}, sort_keys=True))
    finally:
        client.close()
try:
    asyncio.run(main())
except Exception:
    print(json.dumps({'error': 'running_service_readonly_probe_failed'}))
    raise SystemExit(1)
`;
export function measureRunningService(prepared, { run = spawnSync, cli = process.env.FORGE_RAILWAY_CLI || 'railway' } = {}) {
  assert.equal(prepared.plan.publication_mode, 'existing-site', 'Use an existing-site measurement package for production read-only qualification');
  const result = run(cli, ['ssh', '--project', RAILWAY_TARGET.project_id, '--environment', RAILWAY_TARGET.environment_id,
    '--service', RAILWAY_TARGET.service_id, '--', 'python', '-c', RUNNING_SERVICE_PROBE], { encoding: 'utf8', timeout: 55000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, 'Cannot read the running Railway container: authenticated Railway SSH access is required; no local-environment substitution is allowed');
  let measured;
  try { measured = JSON.parse(result.stdout.trim()); } catch { assert.fail('Running-service probe did not return its exact credential-free JSON observation'); }
  validateRunningObservation(measured, prepared.source, { ...RAILWAY_TARGET, deployment_id: prepared.provider.deployment_id, source_sha: prepared.plan.release_sha });
  for (const key of ['database_fingerprint', 'private_storage_fingerprint']) assert.equal(measured[key], prepared.binding[key], `Fresh serving ${key} differs from reviewed proof`);
  if (prepared.releaseException) assert.equal(measured.kitchen_owner_only, true, 'Fresh running Kitchen owner-only flag changed');
  return measured;
}
export function verifyReviewedRuntimeInventory(source, sha, { run = spawnSync } = {}) {
  assert.equal(source.source_sha, sha, 'Runtime inventory belongs to another reviewed commit');
  const listing = run('git', ['ls-tree', '-r', '-z', sha, '--', 'backend/'], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(listing.status, 0, 'Reviewed Git commit is unavailable for exact runtime source inventory');
  const entries = listing.stdout.split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) blob ([a-f0-9]+)\tbackend\/(.+)$/.exec(line);
    assert.ok(match, 'Unexpected reviewed Git tree entry');
    return { mode: match[1], oid: match[2], path: match[3] };
  }).filter(({ path }) => (RUNTIME_ROOT_FILES.includes(path) || RUNTIME_DIRECTORIES.some(directory => path.startsWith(directory + '/'))) && !path.split('/').includes('__pycache__') && !path.endsWith('.pyc'));
  assert.ok(entries.length >= RUNTIME_ROOT_FILES.length, 'Reviewed Git tree omits runtime sources');
  assert.ok(entries.every(entry => entry.mode === '100644' || entry.mode === '100755'), 'Symlinks are forbidden in reviewed runtime inventory');
  const blobs = run('git', ['cat-file', '--batch'], { input: entries.map(entry => entry.oid).join('\n') + '\n', timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(blobs.status, 0, 'Cannot read exact reviewed runtime Git blobs');
  const bytes = Buffer.from(blobs.stdout), files = {}; let offset = 0;
  for (const entry of entries) {
    const end = bytes.indexOf(10, offset); assert.ok(end >= offset, 'Truncated reviewed runtime blob header');
    const header = bytes.subarray(offset, end).toString('utf8').split(' ');
    const size = Number(header[2]); assert.equal(header[0], entry.oid); assert.equal(header[1], 'blob'); assert.ok(Number.isSafeInteger(size) && size >= 0);
    offset = end + 1; assert.ok(offset + size < bytes.length && bytes[offset + size] === 10, 'Truncated reviewed runtime blob');
    files[entry.path] = createHash('sha256').update(bytes.subarray(offset, offset + size)).digest('hex'); offset += size + 1;
  }
  assert.equal(offset, bytes.length, 'Unexpected extra reviewed runtime blob output');
  assert.deepEqual(source.files, files, 'Reviewed inventory hashes do not match the exact committed runtime sources');
  return { sourceSha: sha, runtimeFilesVerifiedAgainstGit: entries.length };
}

export function verifyProtectedSource(sha, { run = spawnSync, cli = 'gh', plan } = {}) {
  const exception = plan ? validateReleaseException(plan, sha) : null;
  const get = path => {
    const result = run(cli, ['api', path, '--method', 'GET'], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, 'Cannot inspect required protected-main GitHub evidence');
    try { return JSON.parse(result.stdout); } catch { assert.fail('GitHub evidence response is not JSON'); }
  };
  const repository = 'repos/luvop2510/buildconhouse';
  const branch = get(repository + '/branches/main');
  if (!exception) assert.equal(branch.commit?.sha, sha, 'Reviewed source has not reached current protected main');
  const protection = get(repository + '/branches/main/protection');
  assert.equal(protection.enforce_admins?.enabled, true, 'Administrator branch protection must remain enforced');
  assert.equal(protection.required_status_checks?.strict, true, 'Required checks must remain up to date');
  assert.ok(protection.required_pull_request_reviews?.required_approving_review_count >= 1, 'Independent approving review is required');
  const required = ['backend', 'frontend', 'frontend-security', 'performance'];
  const contexts = protection.required_status_checks?.contexts || [];
  for (const name of required) assert.ok(contexts.includes(name), `Required protected-main check missing: ${name}`);
  const runs = get(repository + '/commits/' + sha + '/check-runs?per_page=100');
  assert.ok(runs.total_count <= 100, 'Check-run evidence is paginated; inspect the complete exact-head result set');
  for (const name of exception ? required.filter(name => name !== 'frontend-security') : required) {
    const matching = (runs.check_runs || []).filter(row => row.name === name).sort((a, b) => b.id - a.id);
    assert.ok(matching.length && matching[0].head_sha === sha && matching[0].status === 'completed' && matching[0].conclusion === 'success', `Exact protected-main ${name} check is not successful`);
  }
  if (exception) {
    const pull = get(repository + '/pulls/16');
    assert.equal(pull.number, 16); assert.equal(pull.state, 'open');
    assert.equal(pull.base?.ref, 'main'); assert.equal(pull.head?.sha, sha, 'Exception source differs from current Kitchen PR head');
    const security = (runs.check_runs || []).filter(row => row.name === 'frontend-security').sort((a, b) => b.id - a.id)[0];
    assert.ok(security && security.head_sha === sha && security.status === 'completed', 'Current source security result is unavailable');
    assert.ok(['success', 'failure'].includes(security.conclusion), 'Current source security gate was not executed to a pass/fail result');
    return { sourceSha: sha, protectedMain: false, branchProtectionsPreserved: true, sourcePullRequest: 16,
      requiredChecks: required.filter(name => name !== 'frontend-security'),
      releaseException: { authority: exception.authority, expiresAt: exception.expires_at, waivers: exception.waivers },
      frontendSecurity: { actualConclusion: security.conclusion, disposition: 'waived-by-explicit-owner-instruction', passed: security.conclusion === 'success' },
      independentReview: { disposition: 'waived-by-explicit-owner-instruction', approved: false } };
  }
  const pulls = get(repository + '/commits/' + sha + '/pulls?per_page=100');
  assert.ok(pulls.length < 100, 'Pull-request evidence is paginated');
  const merged = pulls.find(row => row.merged_at && row.base?.ref === 'main' && row.merge_commit_sha === sha);
  assert.ok(merged && Number.isSafeInteger(merged.number), 'Current release must be a reviewed pull request merged through main');
  const reviews = get(repository + '/pulls/' + merged.number + '/reviews?per_page=100');
  assert.ok(reviews.length < 100, 'Approving-review evidence is paginated');
  const decisions = new Map();
  for (const row of reviews.sort((a, b) => a.id - b.id)) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(row.state)) decisions.set(row.user?.login, row);
  }
  const approvals = [...decisions.values()].filter(row => row.state === 'APPROVED' && row.user?.login && row.user.login !== merged.user?.login && row.commit_id === merged.head?.sha);
  assert.ok(approvals.length >= protection.required_pull_request_reviews.required_approving_review_count, 'Independent approval of the final merged pull-request head is missing');
  return { sourceSha: sha, protectedMain: true, requiredChecks: required, mergedPullRequest: true };
}

export async function verifyProductionReadonly([manifestPath, output, candidate, sha, deploymentId, expectedManifestHash]) {
  assert.ok(manifestPath && output && candidate && sha && deploymentId && expectedManifestHash, 'Exact reviewed production candidate/manifest identity is required');
  const prepared = loadKitchenPromotionPackage({ manifestPath, candidate, sha });
  assert.equal(prepared.manifestSha256, expectedManifestHash, 'Promotion manifest changed after review');
  assert.equal(prepared.plan.candidate_deployment_id, deploymentId);
  assert.equal(prepared.plan.publication_mode, 'existing-site', 'Production read-only verification requires the explicit existing-site publication mode');
  const origin = canonicalCandidate(candidate).origin, plan = prepared.plan;
  const report = { candidate: origin, releaseSha: sha, deploymentId, startedAt: new Date().toISOString(),
    passed: false, readOnlyBusinessData: true, productionPromoted: false, ownerAccepted: false,
    reviewedEvidence: { manifestSha256: prepared.manifestSha256, isolatedTrialSha256: prepared.trialSha256, productionBindingSha256: plan.production_binding.sha256 },
    operatorAuthorization: { reference: plan.authorization.reference, action: plan.authorization.action, rollbackReference: plan.authorization.rollback_reference },
    measuredBinding: null, checks: [], scope: 'Existing-site production read-only provider/container/source/data/storage binding and Kitchen readiness; own run-owned authentication sessions only. Chromium emulation; no production lifecycle mutations.' };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const sessions = [];
  let browser;
  try {
    report.protectedSource = verifyProtectedSource(sha, { plan });
    report.reviewedRuntimeInventory = verifyReviewedRuntimeInventory(prepared.source, sha);
    report.measuredBinding = measureRunningService(prepared);
    report.checks.push({ check: 'fresh-running-container-source-data-storage-matches-reviewed-proof', passed: true });
    const credentials = JSON.parse(await readFile(process.env.FORGE_KITCHEN_QA_CREDENTIALS_FILE || '', 'utf8'));
    browser = await chromium.launch();
    let blockedWrites = 0;
    async function login(role) {
      const account = plan.accounts[role], credential = credentials[account.credential_key];
      assert.ok(credential?.email && credential?.password, 'Missing approved principal credentials');
      const context = await browser.newContext({ baseURL: origin, serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
      await context.route('**/*', productionBrowserRoute(origin, bypass, () => { blockedWrites += 1; }));
      const baseHeaders = { Origin: origin, ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) };
      const response = await productionRequest(context, origin, baseHeaders, 'POST', '/api/auth/login', { email: credential.email, password: credential.password });
      const session = { context, headers: baseHeaders, role, cookies: [] };
      sessions.push(session); // Retain cleanup ownership even on malformed login.
      assert.equal(response.status(), 200, 'Run-owned real login failed');
      const body = await response.json(), cookies = await context.cookies();
      session.cookies = cookies;
      session.headers = { ...baseHeaders, 'X-Floor-Id': 'second-floor', 'X-CSRF-Token': cookies.find(cookie => cookie.name === 'forge_csrf')?.value || '' };
      assert.equal(body.access_token, '', 'BFF must not return bearer credentials');
      assert.equal(body.user?.id, account.user_id, 'Login is not the approved run-owned principal');
      if (role === 'owner') assert.equal(body.user.role, 'owner');
      const token = decodeURIComponent(cookies.find(cookie => cookie.name === 'forge_session')?.value || '');
      const expiry = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
      assertPersistentCookies(cookies, expiry, await response.headerValues('set-cookie'));
      await context.addInitScript(() => { localStorage.setItem('forge.jwt.kind', JSON.stringify('staff')); localStorage.setItem('forge.active-floor', JSON.stringify('second-floor')); });
      report.checks.push({ check: 'real-login-cookie-contract', role, passed: true });
      return session;
    }
    const owner = await login('owner');
    for (const path of ['/api/health', '/api/health/ready']) {
      const ready = await productionRequest(owner.context, origin, owner.headers, 'GET', path);
      assert.equal(ready.status(), 200, 'Existing-site backend health/readiness is unavailable');
      assert.equal((await ready.json()).status, 'ok', 'Existing-site backend reports degraded readiness');
    }
    report.checks.push({ check: 'existing-site-health-readiness', passed: true });
    const denied = prepared.releaseException ? null : await login('denied');
    for (const path of ['/api/kitchen-projects/configuration', '/api/kitchen-projects/dashboard', '/api/kitchen-projects?limit=1']) {
      const response = await productionRequest(owner.context, origin, owner.headers, 'GET', path);
      assert.equal(response.status(), 200, 'Required authorized Kitchen read failed');
      const body = await response.json();
      if (path.endsWith('configuration')) assert.ok(Array.isArray(body.department_manager_user_ids) && Number.isInteger(body.version));
      else if (path.endsWith('dashboard')) assert.ok(Number.isInteger(body.active_projects) && body.active_projects >= 0 && typeof body.active_order_value === 'string');
      else assert.ok(Array.isArray(body.rows) && body.rows.length <= 1 && Number.isInteger(body.total));
      if (denied) assert.equal((await productionRequest(denied.context, origin, denied.headers, 'GET', path)).status(), 403, 'Denied principal accessed Kitchen');
      else assert.equal((await productionRequest(owner.context, origin, { ...owner.headers, 'X-Floor-Id': 'first-floor' }, 'GET', path)).status(), 403, 'Wrong-floor owner request accessed Kitchen');
      report.checks.push({ check: denied ? 'authorized-and-denied-primary-read' : 'authorized-and-wrong-floor-primary-read', path, passed: true });
    }
    if (!denied) report.verificationLimits = { loggedInDeniedPrincipal: 'Not executed: only the existing owner account is authorized for this hosted release. Local real API denial coverage is separate.', accountsCreated: false };
    const anonymous = await browser.newContext({ baseURL: origin, serviceWorkers: 'block' });
    try {
      assert.equal((await productionRequest(anonymous, origin, { ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) }, 'GET', '/api/kitchen-projects?limit=1')).status(), 401);
    } finally { await anonymous.close(); }
    const page = await owner.context.newPage(), health = captureRuntimeHealth(page);
    const pending = new Set(); let activity = Date.now(); let failedRead = false;
    owner.context.on('request', request => { if (new URL(request.url()).origin === origin && new URL(request.url()).pathname.startsWith('/api/')) { pending.add(request); activity = Date.now(); } });
    const finished = request => { if (pending.delete(request)) activity = Date.now(); };
    owner.context.on('requestfinished', finished); owner.context.on('requestfailed', finished);
    owner.context.on('response', response => { if (new URL(response.url()).origin === origin && new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) failedRead = true; });
    const settle = () => expect.poll(() => pending.size === 0 && Date.now() - activity >= 200, { timeout: 20000 }).toBe(true);
    for (const stage of ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed']) {
      const path = `/kitchen/stages/${stage}`;
      await settle();
      const ready = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === origin && url.pathname === '/api/kitchen-projects' && url.searchParams.get('stage') === stage && response.request().method() === 'GET' && response.status() === 200;
      });
      await page.goto(origin + path); await ready; await settle();
      await expect(page.getByTestId('kitchen-search')).toHaveCount(1); await expect(page.getByTestId('login-submit')).toHaveCount(0);
      assert.equal(failedRead, false, 'Browser Kitchen primary/auxiliary read failed');
      assert.equal(blockedWrites, 0, 'Read-only browser attempted a mutation');
      await health.assertHealthy();
      report.checks.push({ check: 'readonly-browser-session-restoration', path, passed: true });
    }
    report.passed = true;
  } catch (error) {
    // Assertion diagnostics are authored allowlisted messages. Never persist
    // arbitrary provider, credential, request or browser exception strings.
    report.failure = error?.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] : 'Production read-only qualification failed; inspect private diagnostics. No business writes were authorized.';
    process.exitCode = 1;
  } finally {
    for (const session of sessions) {
      try {
        const noCsrf = { ...session.headers }; delete noCsrf['X-CSRF-Token'];
        const rejected = await productionRequest(session.context, origin, noCsrf, 'POST', '/api/auth/logout');
        const csrfRejected = rejected.status() === 403;
        const revoked = await productionRequest(session.context, origin, session.headers, 'POST', '/api/auth/logout');
        await session.context.addCookies(session.cookies);
        const denied = await productionRequest(session.context, origin, session.headers, 'GET', '/api/auth/me');
        assert.equal(revoked.status(), 200); assert.equal(denied.status(), 401);
        report.checks.push({ check: 'own-session-CSRF-rejection', role: session.role, passed: csrfRejected });
        assert.equal(csrfRejected, true, 'BFF failed to reject own-session logout without CSRF');
        report.checks.push({ check: 'own-session-revocation', role: session.role, passed: true });
      } catch { report.passed = false; process.exitCode = 1; report.checks.push({ check: 'own-session-revocation', role: session.role, passed: false }); }
      await session.context.close();
    }
    await browser?.close();
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Production Kitchen read-only qualification: ${report.passed ? 'passed' : 'incomplete/failed'}; no promotion performed`);
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyProductionReadonly(process.argv.slice(2));
