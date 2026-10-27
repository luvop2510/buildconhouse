import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'] as const;
const headers = { 'X-Floor-Id': 'second-floor' };
async function command(api: APIRequestContext, project: any, name: string, payload: object) {
  const response = await api.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
    expected_version: project.version, idempotency_key: randomUUID(), command: name, payload,
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function create(api: APIRequestContext, name: string, detail = false) {
  const suffix = randomUUID().replaceAll('-', '');
  const response = await api.post('/api/kitchen-projects', { headers, data: {
    idempotency_key: randomUUID(),
    customer: { name, phone: `9${BigInt(`0x${suffix.slice(0, 12)}`).toString().slice(-9).padStart(9, '0')}`,
      ...(detail ? { email: `${suffix}@example.com`, address: 'Synthetic complete customer address', company: 'Synthetic kitchen company',
        property_name: 'Synthetic property', city: 'Ahmedabad', state: 'Gujarat', pincode: '380001', alternate_phone: '9000000001', notes: 'Synthetic customer instructions' } : {}) },
    lead: { site_location: `Search site ${suffix}`, notes: 'Saved original lead notes' },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
}
async function dashboard(page: Page) {
  await page.goto('/kitchen');
  await expect(page.getByTestId('kitchen-dashboard-stage-lead')).toBeVisible();
}

test('Dashboard shows all nine authoritative stage totals and opens the matching saved customers', async ({ page, context }, info) => {
  test.setTimeout(90000);
  const health = captureRuntimeHealth(page);
  const projects: any[] = [];
  for (const [index, stage] of stages.entries()) {
    let project = await create(context.request, `Dashboard ${stage} ${randomUUID()}`);
    for (const next of stages.slice(1, index + 1)) project = await command(context.request, project, 'move_stage', { target_stage: next });
    expect(project.stage).toBe(stage);
    projects.push(project);
  }
  const repeated = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: projects[1].customer_id, idempotency_key: randomUUID(), lead: { site_location: 'A second distinct customer project' },
  } });
  expect(repeated.ok(), await repeated.text()).toBe(true);
  await command(context.request, await repeated.json(), 'move_stage', { target_stage: 'visit' });
  await setup(page);
  await dashboard(page);
  const response = await context.request.get('/api/kitchen-projects/dashboard', { headers });
  expect(response.ok(), await response.text()).toBe(true);
  const snapshot = await response.json();
  expect(snapshot.stage_customer_counts.visit).toBeLessThan(snapshot.stage_counts.visit);
  for (const stage of stages) {
    await expect(page.getByTestId(`kitchen-dashboard-count-${stage}`)).toHaveText(String((snapshot.stage_customer_counts || snapshot.stage_counts)[stage]));
  }
  const geometry = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1);
  await page.screenshot({ path: info.outputPath('nine-stage-dashboard.png'), fullPage: true });
  for (const [index, stage] of stages.entries()) {
    await page.getByTestId(`kitchen-dashboard-stage-${stage}`).click();
    await expect(page).toHaveURL(new RegExp(`/kitchen/stages/${stage}(?:\\?.*)?$`));
    await expect(page.getByTestId('kitchen-stage-navigation')).toHaveCount(0);
    await expect(page.locator('[data-testid^="kitchen-queue-stage-"]')).toHaveCount(0);
    await expect(page.getByTestId('kitchen-search')).toBeVisible();
    await expect(page.getByTestId(`kitchen-project-${projects[index].id}`)).toBeVisible();
    const result = await context.request.get(`/api/kitchen-projects?stage=${stage}&limit=25`, { headers });
    const listed = await result.json();
    expect(listed.total).toBe(snapshot.stage_counts[stage]);
    expect(listed.rows.every((row: any) => row.stage === stage)).toBe(true);
    const customerRow = page.getByTestId(`kitchen-project-${projects[index].id}`);
    await expect(customerRow).toContainText(projects[index].customer.phone);
    await customerRow.click();
    await expect(page.getByTestId('kitchen-project-details')).toBeVisible();
    await expect(page.getByTestId('kitchen-project-details')).toContainText(projects[index].customer.name);
    await expect(page.getByTestId('kitchen-current-task-region')).toBeVisible();
    if (stage === 'visit' || stage === 'production') await page.screenshot({ path: info.outputPath(`${stage}-customer-fields.png`), fullPage: true });
    await dashboard(page);
  }
  // A committed stage change must be reflected immediately when the hub reloads.
  await command(context.request, projects[0], 'move_stage', { target_stage: 'visit' });
  await page.getByTestId('kitchen-dashboard-refresh').click();
  await expect(page.getByTestId('kitchen-dashboard-count-lead')).toHaveText(String((snapshot.stage_customer_counts || snapshot.stage_counts).lead - 1));
  await expect(page.getByTestId('kitchen-dashboard-count-visit')).toHaveText(String((snapshot.stage_customer_counts || snapshot.stage_counts).visit + 1));
  await expect(page.getByText('Needs attention', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-testid^="kitchen-dashboard-attention-"]')).toHaveCount(0);
  await health.assertHealthy();
});

test('Mobile stage hub and customer fields remain usable at narrow widths, rotation and enlarged text', async ({ page, context }, info) => {
  const project = await create(context.request, `Mobile customer ${randomUUID()}`, true);
  await setup(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const health = captureRuntimeHealth(page);
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await dashboard(page);
    const stageBoxes = page.getByTestId('kitchen-dashboard-stages').getByRole('link');
    await expect(stageBoxes).toHaveCount(9);
    expect(await stageBoxes.evaluateAll(elements => elements.every(element => {
      const box = element.getBoundingClientRect(); return box.width >= 44 && box.height >= 44;
    }))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByTestId('kitchen-dashboard-stage-lead').click();
    await page.getByTestId(`kitchen-project-${project.id}`).click();
    await expect(page.getByTestId('kitchen-project-details')).toContainText(project.customer.name);
    await expect(page.getByTestId('kitchen-project-details')).not.toContainText(project.customer.email);
    await expect(page.getByTestId('kitchen-lead-site_location')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 720 });
  await dashboard(page);
  await page.getByTestId('kitchen-dashboard').evaluate(root => {
    root.querySelectorAll<HTMLElement>('[dir="auto"]').forEach(text => { text.style.fontSize = '24px'; text.style.lineHeight = '36px'; });
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByTestId('kitchen-dashboard-stage-installation').click();
  await expect(page).toHaveURL(/\/kitchen\/stages\/installation$/);
  await page.screenshot({ path: info.outputPath('mobile-stage-drilldown.png'), fullPage: true });
  await health.assertHealthy();
});

test('Universal search crosses stage queues, opens compact customer identity and saves the selected record', async ({ page, context }, info) => {
  const marker = randomUUID();
  let project = await create(context.request, `Literal [customer] ${marker}`, true);
  project = await command(context.request, project, 'move_stage', { target_stage: 'visit' });
  await setup(page);
  const health = captureRuntimeHealth(page);
  await page.goto('/kitchen/stages/lead');
  await page.getByTestId('kitchen-universal-search-open').click();
  const search = page.getByTestId('kitchen-universal-search-sheet').getByTestId('kitchen-universal-search');
  const requested = page.waitForResponse(row => {
    const url = new URL(row.url());
    return url.pathname === '/api/kitchen-projects' && url.searchParams.get('search') === project.customer.email;
  });
  await search.fill(project.customer.email);
  const found = await requested;
  expect(found.ok(), await found.text()).toBe(true);
  expect(new URL(found.url()).searchParams.has('stage')).toBe(false);
  await expect(page.getByTestId(`kitchen-search-project-${project.id}`)).toContainText('Visit');
  await page.getByTestId(`kitchen-search-project-${project.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/kitchen/${project.id}/stages/visit\\?`));
  const details = page.getByTestId('kitchen-project-details');
  await expect(details).toBeVisible();
  for (const field of ['name', 'phone']) await expect(details).toContainText(project.customer[field]);
  for (const field of ['email', 'address', 'company', 'property_name', 'city', 'state', 'pincode', 'alternate_phone', 'notes']) await expect(details).not.toContainText(project.customer[field]);
  await expect(page.getByTestId('kitchen-customer-current-stage')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-project-actions')).toBeVisible();
  await expect(page.getByTestId('kitchen-project-stages').getByRole('link')).toHaveCount(9);
  await page.getByTestId('kitchen-visit-notes').fill(`Changed from global search ${marker}`);
  await page.getByTestId('kitchen-visit-save').click();
  await expect.poll(async () => {
    const current = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
    return (await current.json()).visit.notes;
  }).toBe(`Changed from global search ${marker}`);
  await page.reload();
  await expect(page.getByTestId('kitchen-visit-notes')).toHaveValue(`Changed from global search ${marker}`);
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Edit customer', exact: true }).click();
  await expect(page.getByTestId('edit-customer-name')).toHaveValue(project.customer.name);
  const updated = { name: `Updated [customer] ${marker}`, email: `updated-${marker}@example.com`, phone: '9001112223' };
  await page.getByTestId('edit-customer-name').fill(updated.name);
  await page.getByTestId('edit-customer-email').fill(updated.email);
  await page.getByTestId('edit-customer-phone').fill(updated.phone);
  const savedContact = page.waitForResponse(row => new URL(row.url()).pathname === `/api/customers/${project.customer_id}` && row.request().method() === 'PATCH');
  await page.getByTestId('edit-customer-save').click();
  const saved = await savedContact;
  expect(saved.ok(), await saved.text()).toBe(true);
  await dashboard(page);
  await page.getByTestId('kitchen-universal-search').fill(updated.email);
  await expect(page.getByTestId(`kitchen-search-project-${project.id}`)).toContainText(updated.name);
  await page.getByTestId(`kitchen-search-project-${project.id}`).click();
  for (const value of [updated.name, updated.phone]) await expect(page.getByTestId('kitchen-project-details')).toContainText(value);
  await expect(page.getByTestId('kitchen-visit-notes')).toHaveValue(`Changed from global search ${marker}`);
  await page.getByTestId('kitchen-page-back').click();
  await expect(page).toHaveURL(/\/kitchen$/);
  await expect(page.getByTestId('kitchen-dashboard-stages')).toBeVisible();
  await page.getByTestId('kitchen-universal-search').fill(project.customer.email);
  await expect(page.getByText('No matching Kitchen customers', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-universal-search').fill(`[customer] ${marker}`);
  await expect(page.getByTestId(`kitchen-search-project-${project.id}`)).toBeVisible();
  await page.getByTestId('kitchen-universal-search').fill(`.*${marker}`);
  await expect(page.getByTestId(`kitchen-search-project-${project.id}`)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('literal-customer-search.png'), fullPage: true });
  await health.assertHealthy();
});

test('Dashboard and universal search recover failed reads and discard a delayed previous search', async ({ page, context }) => {
  const first = await create(context.request, `Slow search ${randomUUID()}`);
  const second = await create(context.request, `Latest search ${randomUUID()}`);
  await setup(page);
  const health = captureRuntimeHealth(page);
  let failDashboard = true;
  await page.route('**/api/kitchen-projects/dashboard', async route => {
    if (!failDashboard) return route.continue();
    failDashboard = false;
    return route.fulfill({ status: 503, json: { detail: 'Synthetic dashboard read failure' } });
  });
  await page.goto('/kitchen');
  await expect(page.getByText('Kitchen dashboard unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('kitchen-dashboard-stages')).toBeVisible();
  let failSearch = true;
  let releaseSlow: (() => void) | undefined;
  const slowHeld = new Promise<void>(resolve => { releaseSlow = resolve; });
  let slowStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { slowStarted = resolve; });
  let slowFinished: (() => void) | undefined;
  const finished = new Promise<void>(resolve => { slowFinished = resolve; });
  await page.route('**/api/kitchen-projects?**', async route => {
    const query = new URL(route.request().url()).searchParams.get('search');
    if (query === first.customer.name) {
      const response = await route.fetch();
      slowStarted?.();
      await slowHeld;
      // The browser may cancel its obsolete request while the real server read finishes.
      await route.fulfill({ response }).catch(() => undefined);
      slowFinished?.();
      return;
    }
    if (query === second.customer.name && failSearch) {
      failSearch = false;
      return route.fulfill({ status: 503, json: { detail: 'Synthetic customer search read failure' } });
    }
    return route.continue();
  });
  const search = page.getByTestId('kitchen-universal-search');
  try {
    await search.fill(first.customer.name);
    await started;
    await search.fill(second.customer.name);
    await expect(page.getByText('Customer search unavailable', { exact: true })).toBeVisible();
    await page.getByTestId('kitchen-universal-search-region').getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByTestId(`kitchen-search-project-${second.id}`)).toBeVisible();
    releaseSlow?.();
    await finished;
    await expect(page.getByTestId(`kitchen-search-project-${first.id}`)).toHaveCount(0);
    await expect(search).toHaveValue(second.customer.name);
    await expect(page.getByTestId(`kitchen-search-project-${second.id}`)).toBeVisible();
    await search.fill('');
    await expect(page.getByTestId(`kitchen-search-project-${second.id}`)).toHaveCount(0);
    await health.assertHealthy();
  } finally { releaseSlow?.(); }
});
