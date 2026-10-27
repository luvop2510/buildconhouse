import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'] as const;
const labels = { lead: 'Lead', visit: 'Visit', cad: 'CAD File', design: 'Design', quotation: 'Quotation', order: 'Order', production: 'Production', installation: 'Installation', completed: 'Completed' };
const headers = { 'X-Floor-Id': 'second-floor' };
async function seed(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
}
async function created(context: BrowserContext) {
  const response = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
    lead: { site_location: 'Independent route matrix synthetic site', notes: 'Saved synthetic route fixture' },
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function command(context: BrowserContext, project: any, name: string, payload: Record<string, unknown> = {}) {
  const response = await context.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
    expected_version: project.version, idempotency_key: randomUUID(), command: name, payload,
  } });
  expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

// No fixture ordering dependency: one owned project is advanced by the actual
// API, and each task URL is visited while that stage is CURRENT and populated.
// The remaining project pages are visited at Completed. This is 30 URLs/case,
// not 30 separately collected test cases or an exhaustive state-role product.
test('30 meaningful URLs: every current stage, persisted pages and scoped queues', async ({ page, context, baseURL, browser }, info) => {
  test.setTimeout(120000);
  const health = captureRuntimeHealth(page);
  await seed(page);
  const policy = await context.request.get('/api/kitchen-projects/configuration', { headers });
  const configured = await context.request.put('/api/kitchen-projects/configuration', { headers, data: {
    expected_version: (await policy.json()).version, decision_contract: '2026-10-20', department_manager_user_ids: [process.env.KITCHEN_E2E_MANAGER_ID],
  } });
  expect(configured.ok(), await configured.text()).toBeTruthy();
  let project = await created(context);
  if (project.duplicate_review?.status === 'pending') project = await command(context, project, 'review_duplicate', { decision: 'distinct_project', reason: 'Independent synthetic distinct site' });
  const manager = await browser.newContext({ baseURL });
  await manager.addCookies([{ name: 'kitchen_acceptance_session', value: 'manager', url: baseURL! }]);
  const visits: any[] = [];
  async function visit(path: string, marker: string, api: string) {
    const response = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === api);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const loaded = await response;
    expect(loaded.ok(), `${path}: ${loaded.status()}`).toBeTruthy();
    if (marker === 'kitchen-project-ready') await expect(page.getByTestId(marker)).toHaveCount(1);
    else await expect(page.getByTestId(marker)).toBeVisible();
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, root: document.documentElement.scrollWidth,
      projectNavigation: Array.from(document.querySelectorAll('[data-testid="kitchen-project-details-toggle"]')).filter(e => (e as HTMLElement).offsetWidth > 0).map(e => {
        const box = e.getBoundingClientRect(); return { left: box.left, right: box.right };
      }) }));
    expect(geometry.root, `${path}: root width`).toBeLessThanOrEqual(geometry.viewport + 1);
    if (path.startsWith(`/kitchen/${project.id}`)) expect(geometry.projectNavigation).toHaveLength(1);
    expect(geometry.projectNavigation.every(box => box.left >= -1 && box.right <= geometry.viewport + 1), `${path}: navigation fit`).toBe(true);
    await health.assertHealthy();
    visits.push({ route: path.replace(project.id, ':project'), role: 'owner', state: project.stage, apiStatus: loaded.status(), geometry });
  }
  try {
    for (const stage of stages) {
      expect(project.stage).toBe(stage);
      await visit(`/kitchen/${project.id}/stages/${stage}`, 'kitchen-current-task-region', `/api/kitchen-projects/${project.id}`);
      await expect(page.getByRole('heading', { name: labels[stage], exact: true }).first()).toBeVisible();
      const sidebarStage = page.getByTestId(`nav-kitchen-${stage}`);
      if (await sidebarStage.isVisible()) await expect(sidebarStage).toHaveAttribute('aria-current', 'page');
      if (stage === 'lead') project = await command(context, project, 'convert');
      if (stage === 'visit') {
        project = await command(context, project, 'save_visit', { status: 'Visited', interested: true, requirements: 'Saved showroom requirements' });
        project = await command(context, project, 'advance_stage', { target_stage: 'cad' });
      }
      if (stage === 'cad') {
        project = await command(context, project, 'save_cad', { received: true, progress: 100, status: 'Completed' });
        project = await command(context, project, 'advance_stage', { target_stage: 'design' });
      }
      if (stage === 'design') {
        project = await command(context, project, 'design_present', { presentation_date: '2026-10-19', url: 'https://example.test/synthetic-design.pdf' });
        const version_id = project.design_versions.at(-1).id;
        project = await command(context, project, 'design_share', { version_id, date: '2026-10-19' });
        project = await command(context, project, 'design_response', { version_id, response: 'Approved', approval_date: '2026-10-19' });
        project = await command(context, project, 'design_handoff', { version_id, date: '2026-10-19' });
        project = await command(context, project, 'advance_stage', { target_stage: 'quotation' });
      }
      if (stage === 'quotation') {
        project = await command(context, project, 'quotation_receive', { design_version_id: project.design_versions.at(-1).id, received_date: '2026-10-19', amount: '1000.01', url: 'https://example.test/synthetic-quotation.pdf' });
        const version_id = project.quotation_versions.at(-1).id;
        project = await command(context, project, 'quotation_share', { version_id, date: '2026-10-19' });
        project = await command(context, project, 'quotation_response', { version_id, response: 'Approved' });
        project = await command(context, project, 'advance_stage', { target_stage: 'order' });
      }
      if (stage === 'order') {
        project = await command(context, project, 'order_confirm', { quotation_version_id: project.quotation_versions.at(-1).id, order_date: '2026-10-19' });
        project = await command(context, project, 'order_advance', { received: true, amount: '0.01', date: '2026-10-19' });
        project = await command(manager, project, 'approval', { scope: 'production', decision: 'Approved' });
        project = await command(context, project, 'advance_stage', { target_stage: 'production' });
      }
      if (stage === 'production') {
        project = await command(context, project, 'production_update', { status: 'Completed', start_date: '2026-10-19', completion_date: '2026-10-20' });
        project = await command(context, project, 'advance_stage', { target_stage: 'installation' });
      }
      if (stage === 'installation') {
        project = await command(context, project, 'installation_update', { status: 'Completed', start_date: '2026-10-20', completion_date: '2026-10-21' });
        project = await command(manager, project, 'approval', { scope: 'closure', decision: 'Approved' });
      }
    }
    for (const [path, marker, api] of [
      ['/kitchen', 'kitchen-dashboard-stage-lead', '/api/kitchen-projects/dashboard'],
      ['/kitchen/projects', 'kitchen-search', '/api/kitchen-projects'],
      ['/kitchen/workflow', 'kitchen-search', '/api/kitchen-projects'],
      ['/kitchen/completed', 'kitchen-search', '/api/kitchen-projects'],
      ['/kitchen/new', 'kitchen-customer-name', '/api/kitchen-projects/configuration'],
      ['/kitchen/review', 'kitchen-search', '/api/kitchen-projects'],
      ['/kitchen/settings', 'kitchen-policy-save', '/api/kitchen-projects/configuration'],
      ...stages.map(stage => [`/kitchen/stages/${stage}`, 'kitchen-search', '/api/kitchen-projects']),
      ...['', '/documents', '/history', '/assignments', '/exceptions'].map(suffix => [`/kitchen/${project.id}${suffix}`, 'kitchen-project-ready', `/api/kitchen-projects/${project.id}`]),
    ]) await visit(path, marker, api);
    expect(visits).toHaveLength(30);
    await page.reload();
    await expect(page.getByTestId('kitchen-project-ready')).toHaveCount(1);
    await health.assertHealthy();
    await info.attach('route-viewport-state-role', { contentType: 'application/json', body: JSON.stringify({ profile: info.project.name, visits }, null, 2) });
    await page.screenshot({ path: info.outputPath('completed-owner-actions.png') });
  } finally { await manager.close(); }
});

test('invalid URLs and independent allowed/denied role scopes preserve authority', async ({ page, context, browser, baseURL }, info) => {
  const health = captureRuntimeHealth(page);
  await seed(page);
  let project = await created(context);
  if (project.duplicate_review?.status === 'pending') project = await command(context, project, 'review_duplicate', { decision: 'distinct_project', reason: 'Independent role fixture' });
  await page.goto(`/kitchen/${project.id}/stages/no-such-stage`);
  await expect(page.getByText('Stage unavailable', { exact: true })).toBeVisible();
  await page.goto('/kitchen/stages/no-such-stage');
  await expect(page.getByText('Stage unavailable', { exact: true })).toBeVisible();
  await page.goto(`/kitchen/${randomUUID()}`);
  await expect(page.getByText('Project unavailable', { exact: true })).toBeVisible();
  await health.assertHealthy();
  const checks: any[] = [];
  for (const role of ['worker', 'manager', 'denied', 'anonymous']) {
    const actor = await browser.newContext({ baseURL, viewport: page.viewportSize() || undefined });
    try {
      await actor.addCookies([{ name: 'kitchen_acceptance_session', value: role, url: baseURL! }]);
      const response = await actor.request.get(`/api/kitchen-projects/${project.id}`, { headers });
      expect(response.status(), `${role}: workspace grant`).toBe(role === 'anonymous' ? 401 : role === 'denied' ? 403 : 200);
      checks.push({ role, state: 'workspace grant', status: response.status() });
      if (role === 'worker') {
        const list = await actor.request.get('/api/kitchen-projects?limit=25', { headers });
        expect((await list.json()).rows.some((row: any) => row.id === project.id)).toBe(true);
        const allowed = await actor.request.get(`/api/kitchen-projects/${project.id}`, { headers });
        expect(allowed.status()).toBe(200);
        expect((await allowed.json()).permissions.can_update).toBe(true);
        const actorPage = await actor.newPage(); const actorHealth = captureRuntimeHealth(actorPage); await seed(actorPage);
        await actorPage.goto(`/kitchen/${project.id}/stages/lead`);
        await expect(actorPage.getByTestId('kitchen-lead-save')).toBeVisible();
        project = await command(context, project, 'convert');
        await actorPage.goto(`/kitchen/${project.id}/stages/visit`);
        await expect(actorPage.getByTestId('kitchen-read-only-notice')).toHaveCount(0);
        await expect(actorPage.getByTestId('kitchen-visit-save')).toBeVisible();
        const write = await actor.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
          expected_version: project.version, idempotency_key: randomUUID(), command: 'save_visit', payload: { requirements: 'Granted Kitchen task' },
        } });
        expect(write.status()).toBe(200);
        project = await write.json();
        checks.push({ role, state: 'grant-based current task and history', read: 200, write: write.status() });
        await actorHealth.assertHealthy();
      }
      if (role === 'manager') {
        const ownerOnly = await actor.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
          expected_version: project.version, idempotency_key: randomUUID(), command: 'order_status', payload: { status: 'On Hold', reason: 'Denied manager exception' },
        } });
        expect(ownerOnly.status()).toBe(403);
      }
    } finally { await actor.close(); }
  }
  const forbiddenFloor = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers: { 'X-Floor-Id': 'first-floor' } });
  expect(forbiddenFloor.status()).toBe(403);
  await info.attach('role-and-invalid-matrix', { contentType: 'application/json', body: JSON.stringify({ profile: info.project.name, checks, otherFloor: forbiddenFloor.status() }) });
});

test('browser Back cancellation and expanded text preserve a directly linked current task', async ({ page, context }, info) => {
  const health = captureRuntimeHealth(page);
  const project = await created(context);
  await seed(page);
  await page.goto(`/kitchen/stages/lead?search=${project.reference}&view=list`);
  await page.getByTestId(`kitchen-project-${project.id}`).click();
  const leadDetails = page.getByTestId('kitchen-lead-details-toggle');
  await expect(leadDetails).toBeVisible();
  if (!await page.getByTestId('kitchen-lead-notes').isVisible()) await leadDetails.click();
  await page.getByTestId('kitchen-lead-notes').fill('Synthetic expanded-text draft');
  const cancelled = page.waitForEvent('dialog').then(dialog => dialog.dismiss());
  await page.goBack(); // Leaving the current task would discard unsaved entries.
  await cancelled;
  await expect(page).toHaveURL(current => current.pathname === `/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-lead-notes')).toHaveValue('Synthetic expanded-text draft');
  const collapsed = page.getByRole('button', { name: 'Collapse sidebar', exact: true });
  if (await collapsed.isVisible()) {
    await collapsed.click();
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  }
  // CSS text enlargement is a web stress check, not native Dynamic Type or OS zoom.
  await page.evaluate(() => {
    const sizes = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="kitchen-project-detail"] *')).map(element => ({ element, font: parseFloat(getComputedStyle(element).fontSize), line: parseFloat(getComputedStyle(element).lineHeight) }));
    for (const { element, font, line } of sizes) { element.style.fontSize = `${font * 1.5}px`; if (Number.isFinite(line)) element.style.lineHeight = `${line * 1.5}px`; }
  });
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, root: document.documentElement.scrollWidth }));
  expect(geometry.root).toBeLessThanOrEqual(geometry.viewport + 1);
  await expect(page.getByTestId('kitchen-lead-save')).toBeVisible();
  const calendars = await page.locator('input[type="date"]').evaluateAll(inputs => inputs.map(input => ({ height: input.getBoundingClientRect().height, width: input.getBoundingClientRect().width })));
  expect(calendars.every(input => input.height >= 44 && input.height < 100 && input.width > 100)).toBe(true);
  await page.screenshot({ path: info.outputPath('current-task-expanded-text.png') });
  await health.assertHealthy();
  await info.attach('expanded-text-scope', { contentType: 'application/json', body: JSON.stringify({ profile: info.project.name, textScale: '150% CSS stress', geometry, calendars, physicalDevice: false }) });
});
