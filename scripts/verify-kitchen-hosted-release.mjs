// Controlled hosted trial. Never run the disposable loopback harness on a host.
// Requires an explicitly approved protected candidate and isolated QA identities/data.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, webkit, devices, expect } from '@playwright/test';
import { captureRuntimeHealth } from '../e2e/runtime-health.ts';
import { assertPersistentCookies } from './verify-release-cookies.mjs';
import { candidateRequest, installCandidateBrowserBoundary } from './kitchen-trial-safety.mjs';
import { KITCHEN_BINDING_PATH, validateRuntimeBinding } from './promote-verified-vercel.mjs';
import { assertMeasuredProductionIdentity } from './verify-kitchen-production-readonly.mjs';

const [manifestPath, output, expectedCandidate, expectedSha, expectedDeployment] = process.argv.slice(2);
assert.ok(manifestPath && output, 'Usage: node --experimental-strip-types scripts/verify-kitchen-hosted-release.mjs <private-approved-manifest.json> <report.json>');
const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
const candidate = new URL(plan.candidate_url);
const origin = candidate.origin;
assert.ok(candidate.protocol === 'https:' && candidate.hostname.endsWith('.vercel.app') && !candidate.username && !candidate.password && candidate.pathname === '/' && !candidate.search && !candidate.hash, 'Use the immutable protected Vercel candidate, not a production alias');
assert.match(plan.release_sha || '', /^[a-f0-9]{40}$/);
if (expectedCandidate) assert.equal(origin, new URL(expectedCandidate).origin, 'Trial candidate differs from promotion candidate');
if (expectedSha) assert.equal(plan.release_sha, expectedSha, 'Trial source differs from promotion source');
if (expectedDeployment) assert.equal(plan.candidate_deployment_id, expectedDeployment, 'Trial deployment differs from promotion deployment');
assert.ok(plan.authorized_isolated_trial === true && plan.synthetic_only === true, 'Explicit isolated trial authorization required');
for (const key of ['candidate_deployment_id', 'backend_deployment_id', 'database_fingerprint', 'private_storage_fingerprint', 'restore_evidence', 'source_binding_evidence', 'authorization_reference']) assert.ok(typeof plan[key] === 'string' && plan[key].length > 5, `Missing reviewed ${key}`);
assert.ok(plan.customer_id && plan.accounts?.owner && plan.accounts?.manager && plan.accounts?.worker && plan.accounts?.denied, 'Preprovisioned synthetic customer and QA accounts required');
assert.equal(plan.run_owned_qa_accounts, true, 'Trial accounts must be explicitly run-owned');
for (const role of ['owner', 'manager', 'worker', 'denied']) assert.ok(typeof plan.account_user_ids?.[role] === 'string' && plan.account_user_ids[role].length > 5, 'Exact approved run-owned principal IDs required');
assert.equal(new Set(Object.values(plan.account_user_ids)).size, 4, 'Trial roles require four distinct principals');
// Text declarations do not establish data isolation. Require independently
// reviewed evidence, then compare the actual serving identity before writes.
// This probe is still UNIMPLEMENTED; trial execution must fail closed today.
assert.ok(plan.runtime_binding?.path && /^[a-f0-9]{64}$/.test(plan.runtime_binding.sha256 || ''), 'Reviewed isolated runtime binding evidence required');
const bindingBytes = await readFile(resolve(dirname(manifestPath), plan.runtime_binding.path));
assert.equal(createHash('sha256').update(bindingBytes).digest('hex'), plan.runtime_binding.sha256, 'Isolated binding evidence changed');
const binding = JSON.parse(bindingBytes.toString());
validateRuntimeBinding(binding, 'isolated', origin, plan.release_sha);
assert.equal(binding.frontend_deployment_id, plan.candidate_deployment_id);
assert.equal(binding.backend_deployment_id, plan.backend_deployment_id);
assert.equal(binding.database_fingerprint, plan.database_fingerprint);
assert.equal(binding.private_storage_fingerprint, plan.private_storage_fingerprint);
const metadata = JSON.parse(execFileSync(process.env.FORGE_VERCEL_CLI || 'vercel', ['api', `/v13/deployments/${encodeURIComponent(candidate.hostname)}?teamId=team_TNMtYYjniBWtCj1l58NEFSPG`, '--method', 'GET'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
assert.equal(metadata.projectId, 'prj_RuZWSvov1AkP2UDmWaea6925wWlU', 'Candidate belongs to another project');
assert.equal(metadata.url, candidate.hostname, 'Use canonical immutable deployment URL, not a mutable alias');
assert.equal(metadata.id, plan.candidate_deployment_id);
assert.equal(metadata.meta?.releaseSha, plan.release_sha);
assert.equal(metadata.readyState, 'READY');
const credentials = JSON.parse(await readFile(process.env.FORGE_KITCHEN_QA_CREDENTIALS_FILE || '', 'utf8'));
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
const report = { candidate: origin, releaseSha: plan.release_sha, startedAt: new Date().toISOString(), checks: [],
  sourceIdentity: { frontend: plan.candidate_deployment_id, frontendMetadataMeasured: true, backend: plan.backend_deployment_id, database: plan.database_fingerprint, storage: plan.private_storage_fingerprint, backendBindingKind: 'operator-supplied, runtime attestation still required' },
  scope: 'Real BFF login, cookies/CSRF, actual backend/Mongo/private provider bytes and synthetic workflow. Emulated browsers; owner acceptance separate.',
  ownerAccepted: false, productionPromoted: false, passed: false };
let browser;
const sessions = [];
try {
  browser = await chromium.launch();
  async function login(role) {
    const context = await browser.newContext({ baseURL: origin, serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    await installCandidateBrowserBoundary(context, origin, bypass);
    // APIRequestContext does not use browser routes; supply bypass only to this exact origin.
    const deployment = { Origin: origin, ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) };
    const credential = credentials[plan.accounts[role]];
    assert.ok(credential?.email && credential?.password, `Missing run-owned ${role} credentials`);
    const response = await candidateRequest(context, origin, 'post', '/api/auth/login', { headers: deployment, data: credential });
    const cookies = await context.cookies();
    const csrf = cookies.find(cookie => cookie.name === 'forge_csrf')?.value;
    const headers = { ...deployment, 'X-Floor-Id': 'second-floor', 'X-CSRF-Token': csrf || '' };
    const session = { context, headers, role, userId: undefined, issuedCookies: cookies };
    sessions.push(session);
    assert.equal(response.status(), 200, `${role}: real login failed`);
    const body = await response.json();
    assert.equal(body.user?.id, plan.account_user_ids[role], 'Login differs from approved run-owned principal');
    if (role === 'owner') assert.equal(body.user.role, 'owner');
    session.userId = body.user.id;
    assert.ok(body.access_token === '' && body.user?.id, `${role}: BFF login must keep bearer out of browser response`);
    const cookieToken = decodeURIComponent(cookies.find(cookie => cookie.name === 'forge_session')?.value || '');
    const expiry = JSON.parse(Buffer.from(cookieToken.split('.')[1], 'base64url').toString()).exp;
    assertPersistentCookies(cookies, expiry, await response.headerValues('set-cookie'));
    await context.addInitScript(() => {
      localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
      localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
    });
    report.checks.push({ role, check: 'real-login-persistent-secure-cookies', passed: true });
    return session;
  }
  const owner = await login('owner'), manager = await login('manager'), worker = await login('worker'), denied = await login('denied');
  const api = async (actor, method, path, data) => candidateRequest(actor.context, origin, method, `/api/kitchen-projects${path}`, { headers: actor.headers, ...(data ? { data } : {}) });
  const identity = await candidateRequest(owner.context, origin, 'get', KITCHEN_BINDING_PATH, { headers: owner.headers });
  assert.equal(identity.status(), 200, 'UNIMPLEMENTED or unavailable isolated runtime binding probe; no trial business writes allowed');
  assertMeasuredProductionIdentity(await identity.json(), binding);
  report.runtimeBinding = binding;
  report.checks.push({ check: 'runtime-binding-measured', passed: true });
  const policyResponse = await api(owner, 'get', '/configuration');
  assert.equal(policyResponse.status(), 200);
  const policy = await policyResponse.json();
  assert.ok(policy.department_manager_user_ids.includes(manager.userId), 'Preprovision selected manager; trial never mutates live policy');
  const create = await api(owner, 'post', '', { customer_id: plan.customer_id, idempotency_key: randomUUID(), lead: { site_location: `Synthetic hosted trial ${randomUUID()}`, notes: 'Run-owned isolated release verification' } });
  assert.equal(create.status(), 200, 'Synthetic lead creation failed');
  let project = await create.json();
  const projectId = project.id, reference = project.project_reference;
  async function command(name, payload = {}, actor = owner, expectedStatus = 200, key = randomUUID()) {
    const response = await api(actor, 'post', `/${projectId}/commands`, { command: name, payload, expected_version: project.version, idempotency_key: key });
    assert.equal(response.status(), expectedStatus, `${actor.role}: ${name}`);
    if (expectedStatus === 200) project = await response.json();
    return response;
  }
  assert.equal((await api(denied, 'get', `/${projectId}`)).status(), 403);
  assert.equal((await api(worker, 'get', `/${projectId}`)).status(), 404);
  await command('assign', { stage: 'lead', user_id: worker.userId });
  assert.equal((await api(worker, 'get', `/${projectId}`)).status(), 200);
  await command('order_status', { status: 'On Hold', reason: 'Denied manager exception' }, manager, 403);
  await command('advance_stage', { target_stage: 'production' }, owner, 422);
  if (project.duplicate_review?.status === 'pending') await command('review_duplicate', { decision: 'distinct_project', reason: 'Isolated run-owned separate QA site' });
  await command('convert');
  await command('save_visit', { requirements: 'Denied worker task' }, worker, 403);
  assert.equal(project.project_reference, reference);
  await command('save_visit', { status: 'Visited', requirements: 'Synthetic showroom requirements', interested: true });
  await command('advance_stage', { target_stage: 'cad' });
  await command('save_cad', { received: true, progress: 100, status: 'Completed' });
  await command('advance_stage', { target_stage: 'design' });
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n');
  const fileResponse = await candidateRequest(owner.context, origin, 'post', `/api/kitchen-projects/${projectId}/attachments`, { headers: owner.headers,
    multipart: { expected_version: String(project.version), idempotency_key: randomUUID(), file: { name: 'synthetic-hosted-trial.pdf', mimeType: 'application/pdf', buffer: bytes } } });
  assert.equal(fileResponse.status(), 200, 'Private provider upload');
  project = await fileResponse.json();
  const attachmentId = project.attachments.at(-1).id;
  const download = await api(owner, 'get', `/${projectId}/attachments/${attachmentId}`);
  assert.equal(download.status(), 200);
  assert.equal(createHash('sha256').update(await download.body()).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await api(denied, 'get', `/${projectId}/attachments/${attachmentId}`)).status(), 403);
  const large = Buffer.alloc(25_000_000, 65); large.write('%PDF-1.4');
  const largeHash = createHash('sha256').update(large).digest('hex');
  const transferStart = await api(owner, 'post', `/${projectId}/file-transfers`, { expected_version: project.version, idempotency_key: randomUUID(), filename: 'synthetic-25mb.pdf', content_type: 'image/vnd.pdf', size_bytes: large.length, sha256: largeHash });
  assert.equal(transferStart.status(), 200, '25 MB transfer startup');
  const transfer = await transferStart.json();
  for (let index = 0; index < transfer.part_count; index++) {
    const part = large.subarray(index * transfer.chunk_bytes, (index + 1) * transfer.chunk_bytes);
    const uploaded = await api(owner, 'put', `/${projectId}/file-transfers/${transfer.transfer_id}/parts/${index}`, { data_base64: part.toString('base64') });
    assert.equal(uploaded.status(), 200, '25 MB bounded part upload');
  }
  const largeFinished = await api(owner, 'post', `/${projectId}/file-transfers/${transfer.transfer_id}/finish`, { expected_version: project.version });
  assert.equal(largeFinished.status(), 200, '25 MB private provider commit');
  project = await largeFinished.json();
  const largeFile = project.attachments.find(file => file.sha256 === largeHash);
  assert.ok(largeFile, '25 MB immutable attachment missing');
  const downloadedHash = createHash('sha256');
  for (let index = 0; index < transfer.part_count; index++) {
    const part = await api(owner, 'get', `/${projectId}/attachments/${largeFile.id}/parts/${index}`);
    assert.equal(part.status(), 200);
    assert.ok((await part.body()).length < 1024 * 1024, 'Download envelope exceeded ordinary transport');
    downloadedHash.update(Buffer.from((await part.json()).data_base64, 'base64'));
  }
  assert.equal(downloadedHash.digest('hex'), largeHash);
  report.checks.push({ check: 'private-25mb-bounded-upload-download', bytes: large.length, passed: true });
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  await command('design_present', { presentation_date: date, attachment_id: attachmentId });
  const designId = project.design_versions.at(-1).id;
  await command('design_share', { version_id: designId, date });
  await command('design_response', { version_id: designId, response: 'Approved' });
  await command('design_handoff', { version_id: designId, date });
  await command('advance_stage', { target_stage: 'quotation' });
  await command('quotation_receive', { design_version_id: designId, received_date: date, amount: '1000.01', attachment_id: attachmentId });
  const quoteId = project.quotation_versions.at(-1).id;
  await command('quotation_share', { version_id: quoteId, date });
  await command('quotation_response', { version_id: quoteId, response: 'Approved' });
  await command('advance_stage', { target_stage: 'order' });
  await command('order_confirm', { quotation_version_id: quoteId, order_date: date });
  await command('order_advance', { received: true, amount: '0.01', date });
  await command('approval', { scope: 'production', decision: 'Approved' }, manager);
  await command('advance_stage', { target_stage: 'production' });
  await command('production_update', { status: 'Completed', start_date: date, completion_date: date });
  await command('advance_stage', { target_stage: 'installation' });
  const visitKey = randomUUID();
  await command('site_visit', { date, actual: true }, owner, 200, visitKey);
  await command('site_visit', { date, actual: true }, owner, 200, visitKey);
  assert.equal(project.site_visit_count, 1);
  await command('site_visit', { date, actual: true });
  assert.equal(project.site_visit_count, 2);
  await command('installation_update', { status: 'Completed', start_date: date, completion_date: date });
  assert.equal(project.stage, 'installation');
  await command('approval', { scope: 'closure', decision: 'Approved' }, manager);
  assert.equal(project.stage, 'completed');
  assert.equal(project.order_amount, '1000.01');
  const exported = await api(owner, 'get', `/export?search=${encodeURIComponent(reference)}`);
  assert.equal(exported.status(), 200);
  assert.ok((await exported.text()).includes(reference));
  report.checks.push({ check: 'actual-hosted-lifecycle-private-bytes-idempotent-visits-export-and-denials', passed: true });
  const urls = [...stages.map(stage => `/kitchen/stages/${stage}`), `/kitchen/${projectId}`,
    ...['documents', 'history', 'assignments', 'exceptions'].map(page => `/kitchen/${projectId}/${page}`),
    ...stages.map(stage => `/kitchen/${projectId}/stages/${stage}`)];
  for (const [profile, engine, options] of [['desktop-chromium', chromium, { viewport: { width: 1440, height: 1000 } }], ['iphone-webkit', webkit, devices['iPhone 13']]]) {
    const viewBrowser = await engine.launch();
    try {
      const view = await viewBrowser.newContext({ ...options, storageState: await owner.context.storageState(), serviceWorkers: 'block' });
      await view.addInitScript(() => { localStorage.setItem('forge.jwt.kind', JSON.stringify('staff')); localStorage.setItem('forge.active-floor', JSON.stringify('second-floor')); });
      await installCandidateBrowserBoundary(view, origin, bypass);
      const page = await view.newPage(), health = captureRuntimeHealth(page);
      const pending = new Set();
      let activity = Date.now();
      const reads = new Map();
      page.on('request', request => {
        if (new URL(request.url()).origin === origin && new URL(request.url()).pathname.startsWith('/api/')) { pending.add(request); activity = Date.now(); }
      });
      const finished = request => { if (pending.delete(request)) activity = Date.now(); };
      page.on('requestfinished', finished); page.on('requestfailed', finished);
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === origin && response.request().method() === 'GET' && url.pathname.startsWith('/api/kitchen-projects')) reads.set(url.pathname, response.status());
      });
      const settle = () => expect.poll(() => pending.size === 0 && Date.now() - activity > 150, { timeout: 15000 }).toBe(true);
      for (const path of urls) {
        await settle(); reads.clear();
        await page.goto(origin + path);
        await expect(page).toHaveURL(origin + path);
        await expect(page.getByTestId('login-submit')).toHaveCount(0);
        const projectPage = path.includes(projectId);
        const required = ['/api/kitchen-projects/configuration', '/api/kitchen-projects/assignees'];
        if (projectPage) {
          required.push(`/api/kitchen-projects/${projectId}`);
          await expect(page.getByTestId('kitchen-project-ready')).toHaveCount(1);
          if (path.endsWith('/documents')) await expect(page.getByTestId('kitchen-documents-page')).toBeVisible();
          else if (path.endsWith('/history')) await expect(page.getByTestId('kitchen-history-category')).toBeVisible();
          else if (path.endsWith('/assignments')) await expect(page.getByTestId('kitchen-next-action')).toBeVisible();
          else if (path.endsWith('/exceptions')) await expect(page.getByTestId('kitchen-exception-reason')).toBeVisible();
          else if (path.includes('/stages/')) await expect(page.getByTestId('kitchen-current-task-region')).toBeVisible();
          else await expect(page.getByTestId('kitchen-current-task-region')).toBeVisible();
        } else {
          required.push('/api/kitchen-projects');
          await expect(page.getByTestId('kitchen-search')).toBeVisible();
        }
        await expect.poll(() => required.every(endpoint => reads.get(endpoint) === 200), { timeout: 15000 }).toBe(true);
        await settle();
        for (const status of reads.values()) assert.equal(status, 200, 'Kitchen page had an unsuccessful API read');
        await health.assertHealthy();
        report.checks.push({ profile, path: path.replace(projectId, '[synthetic-project]'), check: 'route-specific-readiness', apiReads: [...reads].map(([endpoint, status]) => ({ endpoint: endpoint.replace(projectId, '[synthetic-project]'), status })), passed: true });
      }
      report.checks.push({ profile, check: '30-routes-owner-session-completed-project', routes: urls.length, currentProjectStage: 'completed', allStateRoleCombinations: false, passed: true });
      await view.close();
    } finally { await viewBrowser.close(); }
  }
  // A forged CSRF value must be rejected before a business command is applied.
  const csrfDenied = await candidateRequest(owner.context, origin, 'post', `/api/kitchen-projects/${projectId}/commands`, { headers: { ...owner.headers, 'X-CSRF-Token': 'invalid' }, data: {} });
  assert.equal(csrfDenied.status(), 403);
  report.checks.push({ check: 'CSRF-rejection', passed: true });
  report.passed = true;
} catch (error) {
  // Do not include response bodies, credentials, account names, cookies or JWTs.
  report.failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Hosted trial failed; inspect locally without publishing credentials';
  process.exitCode = 1;
} finally {
  for (const session of sessions) {
    try {
      const revoked = await candidateRequest(session.context, origin, 'post', '/api/auth/logout', { headers: session.headers });
      await session.context.addCookies(session.issuedCookies);
      const denied = await candidateRequest(session.context, origin, 'get', '/api/auth/me', { headers: session.headers });
      assert.equal(revoked.status(), 200); assert.equal(denied.status(), 401);
      report.checks.push({ role: session.role, check: 'own-session-revocation', passed: true });
    } catch { report.passed = false; process.exitCode = 1; report.checks.push({ role: session.role, check: 'own-session-revocation', passed: false }); }
    await session.context.close();
  }
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Hosted Kitchen trial: ${report.passed ? 'passed' : 'incomplete/failed'}; report ${output}`);
}
