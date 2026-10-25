import { expect, test, type Page } from '@playwright/test';
import { captureRuntimeHealth } from './runtime-health';

// Actual exported application and disposable API/Mongo supplied by the owned runner.
// No business API interception or mocked persistence.
const headers = { 'X-Floor-Id': 'second-floor' };
async function seedBrowser(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
}

test('Kitchen panels keep padded fields and every stage reachable in a short viewport', async ({ page, context }, info) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 600 });
  await seedBrowser(page);
  await page.goto('/kitchen/stages/lead');
  await page.getByTestId('kitchen-create').click();
  const leadPanel = await page.getByTestId('kitchen-create-sheet').boundingBox();
  const name = await page.getByTestId('kitchen-customer-name').boundingBox();
  expect(name!.x - leadPanel!.x, 'The rendered customer input keeps the panel gutter').toBeGreaterThanOrEqual(16);
  await page.getByTestId('kitchen-create-lead-details-toggle').click();
  if (info.project.name === 'kitchen-desktop') {
    const body = page.getByTestId('kitchen-create-sheet-scroll');
    await body.hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => body.evaluate(element => element.scrollTop), { message: 'A real desktop wheel gesture scrolls the Add Lead body' }).toBeGreaterThan(0);
    await expect(page.getByTestId('kitchen-create-submit')).toBeInViewport();
  } else await page.getByTestId('kitchen-create-submit').scrollIntoViewIfNeeded();
  const submit = await page.getByTestId('kitchen-create-submit').boundingBox();
  expect(submit!.y + submit!.height).toBeLessThanOrEqual(leadPanel!.y + leadPanel!.height);
  await page.screenshot({ path: info.outputPath('add-lead-panel.png') });
  await page.getByTestId('kitchen-create-sheet-close').click();
  await page.getByTestId('kitchen-filters-open').click();
  const filters = page.getByTestId('kitchen-filters');
  await page.getByTestId('kitchen-filters-apply').scrollIntoViewIfNeeded();
  const panel = await filters.boundingBox();
  const apply = await page.getByTestId('kitchen-filters-apply').boundingBox();
  expect(apply!.x - panel!.x, 'Filter controls have an inner gutter').toBeGreaterThanOrEqual(16);
  expect(apply!.y + apply!.height, 'Apply remains within the visible panel').toBeLessThanOrEqual(panel!.y + panel!.height);
  await page.getByTestId('kitchen-filters-apply').click();
  const created = await context.request.post('/api/kitchen-projects', { headers, data: { customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `panel-scroll-${Date.now()}-${Math.random()}`, lead: { site_location: 'Panel reachability check' } } });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await page.getByTestId('kitchen-open-workflow').click();
  await page.getByTestId('kitchen-stage-completed').scrollIntoViewIfNeeded();
  const workflow = await page.getByTestId('kitchen-workflow-sheet').boundingBox();
  const completed = await page.getByTestId('kitchen-stage-completed').boundingBox();
  expect(completed!.x - workflow!.x).toBeGreaterThanOrEqual(16);
  expect(completed!.y + completed!.height).toBeLessThanOrEqual(workflow!.y + workflow!.height);
  await page.screenshot({ path: info.outputPath('workflow-panel.png') });
});

test('Kitchen customer details remain editable and persist after reopening the full customer editor', async ({ page, context }) => {
  const phone = `9${String(Date.now() + Math.floor(Math.random() * 1000000)).slice(-9)}`;
  const created = await context.request.post('/api/kitchen-projects', { headers, data: { customer: { name: 'Kitchen editable customer', phone }, idempotency_key: `editable-customer-${Date.now()}-${Math.random()}`, lead: { site_location: 'Customer editor acceptance site' } } });
  expect(created.ok(), await created.text()).toBe(true);
  const project = await created.json();
  await seedBrowser(page);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await page.getByTestId('kitchen-edit-customer').click();
  await expect(page).toHaveURL(new RegExp(`/customers/${project.customer_id}/edit$`));
  await expect(page.getByTestId('edit-customer-name')).toHaveValue('Kitchen editable customer');
  await page.getByTestId('edit-customer-name').fill('Kitchen updated customer');
  await page.getByTestId('edit-customer-property-name').fill('Updated kitchen property');
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/customers/${project.customer_id}`);
  await page.getByTestId('edit-customer-save').click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const persisted = await context.request.get(`/api/customers/${project.customer_id}`, { headers });
  expect(await persisted.json()).toMatchObject({ name: 'Kitchen updated customer', property_name: 'Updated kitchen property', phone });
  await page.reload();
  await expect(page.getByTestId('edit-customer-name')).toHaveValue('Kitchen updated customer');
  await expect(page.getByTestId('edit-customer-property-name')).toHaveValue('Updated kitchen property');
});

test('Lead records a new customer inline, carries identity forward and reuses their phone on retry', async ({ page, context }, info) => {
  const health = captureRuntimeHealth(page);
  await seedBrowser(page);
  await page.goto('/kitchen/stages/lead');
  await page.getByTestId('kitchen-create').click();
  await expect(page.getByTestId('kitchen-create-submit')).toBeDisabled();
  const phone = `9${String(Date.now() + Math.floor(Math.random() * 1000000)).slice(-9)}`;
  const name = `Inline Kitchen ${info.project.name}`;
  await page.getByTestId('kitchen-customer-name').fill(name);
  await page.getByTestId('kitchen-customer-phone').fill(phone);
  await page.getByTestId('kitchen-create-lead-site_location').fill('Synthetic inline intake site');
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/kitchen-projects' && response.request().method() === 'POST');
  await page.getByTestId('kitchen-create-submit').click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const project = await response.json();
  expect(project.customer).toMatchObject({ name, phone });
  expect(project.stage).toBe('lead');
  await expect(page).toHaveURL(current => current.pathname === `/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-project-detail')).toContainText(name);
  const converted = page.waitForResponse(response => response.request().postDataJSON()?.command === 'move_stage');
  await page.getByTestId('kitchen-convert').click();
  const visit = await (await converted).json();
  expect(visit).toMatchObject({ id: project.id, customer_id: project.customer_id, stage: 'visit' });
  const reused = await context.request.post('/api/kitchen-projects', { headers, data: { customer: { name: 'Do not overwrite this existing customer', phone: `+91 ${phone}` }, idempotency_key: `inline-reuse-${Date.now()}-${Math.random()}`, lead: { site_location: 'Second synthetic location' } } });
  expect(reused.ok(), await reused.text()).toBe(true);
  expect(await reused.json()).toMatchObject({ customer_id: project.customer_id, customer: { name }, stage: 'lead', duplicate_review: { status: 'pending' } });
  await health.assertHealthy();
});

test('responsive board and table retain their truthful representations through width changes', async ({ page, context }, testInfo) => {
  const created = await context.request.post('/api/kitchen-projects', { headers, data: { customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `responsive-board-${Date.now()}-${Math.random()}`, lead: { site_location: 'Independent responsive board site' } } });
  expect(created.ok(), await created.text()).toBe(true);
  const health = captureRuntimeHealth(page);
  await seedBrowser(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/kitchen/stages/lead?view=board');
  await expect(page.getByTestId('kitchen-board-compact')).toBeVisible();
  await expect(page.getByTestId('kitchen-board')).toContainText('Cards and column counts show this page');
  await expect(page.getByTestId('kitchen-board-group-lead')).toBeVisible();
  await expect(page.getByTestId('kitchen-board-group-completed')).toHaveCount(0);
  for (const [width, height] of [[768, 1024], [820, 1180], [844, 390], [320, 720]]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId('kitchen-board-compact')).toBeVisible();
    await expect(page.getByTestId('kitchen-board-group-lead')).toBeVisible();
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(geometry.document, `${width}×${height} root fits`).toBeLessThanOrEqual(geometry.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath(`compact-board-${width}x${height}.png`) });
  }
  await page.getByTestId('kitchen-view-menu').click();
  await page.getByRole('menuitem', { name: 'Table', exact: true }).click();
  await expect(page.getByTestId('kitchen-table')).toBeVisible();
  const row = page.getByRole('row').first();
  await expect(row).toContainText('Status:');
  await expect(row).toContainText('Phone:');
  await expect(row).toContainText('Site location:');
  await expect(row).toContainText('Budget:');
  await expect(row).toContainText('Target completion:');
  await expect(row).not.toContainText('Next action:');
  await expect(row).not.toContainText('Assigned to:');
  await health.assertHealthy();
});

test('stage filters use status choices and calendar inputs; navigation stays within the nine queues', async ({ page }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const pending = new Set<import('@playwright/test').Request>();
  let activity = Date.now();
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) { pending.add(request); activity = Date.now(); } });
  const finished = (request: import('@playwright/test').Request) => { if (pending.delete(request)) activity = Date.now(); };
  page.on('requestfinished', finished); page.on('requestfailed', finished);
  const settle = () => expect.poll(() => pending.size === 0 && Date.now() - activity >= 150, { timeout: 10000 }).toBe(true);
  await seedBrowser(page);
  await page.goto('/kitchen/stages/visit');
  await page.getByTestId('kitchen-filters-open').click();
  await page.getByTestId('kitchen-status-filter').click();
  await expect(page.getByRole('menuitem', { name: 'Visited', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Qualified', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Visited', exact: true }).click();
  await expect(page.getByTestId('kitchen-date-from')).toHaveAttribute('type', 'date');
  await expect(page.getByTestId('kitchen-date-to')).toHaveAttribute('type', 'date');
  for (const id of ['kitchen-date-from', 'kitchen-date-to']) {
    const size = await page.getByTestId(id).boundingBox();
    expect(size?.height, 'Calendar hit target is comfortable').toBeGreaterThanOrEqual(44);
    expect(size?.height, 'Calendar line height uses CSS pixels, not a unitless multiplier').toBeLessThan(64);
  }
  await page.getByTestId('kitchen-date-from').fill('2026-10-21');
  await page.getByTestId('kitchen-date-to').fill('2026-10-20');
  await expect(page.getByTestId('kitchen-filters-apply')).toBeDisabled();
  await page.getByTestId('kitchen-date-to').fill('2026-10-22');
  await page.screenshot({ path: testInfo.outputPath('stage-aware-filters.png') });
  await page.getByTestId('kitchen-filters-apply').click();
  await expect(page).toHaveURL(current => current.searchParams.get('status') === 'Visited' && current.searchParams.get('date_from') === '2026-10-21');
  await settle();
  const queueRead = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/kitchen-projects' && new URL(response.url()).searchParams.get('stage') === 'design');
  await page.getByTestId('kitchen-stage-navigation').click();
  await page.getByRole('menuitem', { name: '4. Design', exact: true }).click();
  await expect(page).toHaveURL(/\/kitchen\/stages\/design$/);
  const response = await queueRead;
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).rows.every((row: { stage: string }) => row.stage === 'design')).toBe(true);
  await expect(page.getByTestId('kitchen-create')).toHaveCount(0);
  await settle();
  await health.assertHealthy();
});

test('manager settings conflict reload requires explicit draft reconciliation', async ({ page, context, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  await seedBrowser(page);
  const initialResponse = await context.request.get(`${baseURL}/api/kitchen-projects/configuration`, { headers });
  expect(initialResponse.ok()).toBeTruthy();
  const original = await initialResponse.json();
  const workerId = process.env.KITCHEN_E2E_WORKER_ID!;
  const managerId = process.env.KITCHEN_E2E_MANAGER_ID!;
  expect(workerId).toBeTruthy(); expect(managerId).toBeTruthy();
  try {
    await page.goto('/kitchen/settings');
    await expect(page.getByTestId('kitchen-policy-save')).toBeEnabled();
    await page.getByTestId(`kitchen-policy-manager-${workerId}`).click();
    const changed = await context.request.put(`${baseURL}/api/kitchen-projects/configuration`, { headers, data: { decision_contract: '2026-10-20', expected_version: original.version, department_manager_user_ids: [managerId] } });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const current = await changed.json();
    const conflict = page.waitForResponse(response => response.url().endsWith('/api/kitchen-projects/configuration') && response.request().method() === 'PUT');
    await page.getByTestId('kitchen-policy-save').click();
    expect((await conflict).status()).toBe(409);
    await expect(page.getByTestId('kitchen-policy-save')).toBeDisabled();
    await page.getByRole('button', { name: 'Reload current record', exact: true }).click();
    await expect(page.getByTestId('kitchen-policy-keep-draft')).toBeVisible();
    await expect(page.getByTestId('kitchen-policy-save')).toBeDisabled();
    await expect(page.getByTestId(`kitchen-policy-manager-${workerId}`)).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('manager-policy-reconcile.png') });
    await page.getByTestId('kitchen-policy-use-current').click();
    await expect(page.getByTestId(`kitchen-policy-manager-${workerId}`)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId(`kitchen-policy-manager-${managerId}`)).toHaveAttribute('aria-pressed', 'true');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/kitchen-projects/configuration') && response.request().method() === 'PUT');
    await page.getByTestId('kitchen-policy-save').click();
    const result = await saved;
    expect(result.request().postDataJSON().expected_version).toBe(current.version);
    expect(result.ok(), await result.text()).toBeTruthy();
    const savedPolicy = await result.json();
    expect(savedPolicy.department_manager_user_ids).toEqual([managerId]);
    // The alternative reconciliation must preserve the draft deliberately, never
    // silently attach it to a refreshed version.
    await expect(page.getByTestId('kitchen-policy-save')).toBeEnabled();
    await page.getByTestId(`kitchen-policy-manager-${workerId}`).click();
    const changedAgain = await context.request.put(`${baseURL}/api/kitchen-projects/configuration`, { headers, data: { decision_contract: '2026-10-20', expected_version: savedPolicy.version, department_manager_user_ids: [managerId] } });
    expect(changedAgain.ok(), await changedAgain.text()).toBeTruthy();
    const currentAgain = await changedAgain.json();
    const conflictAgain = page.waitForResponse(response => response.url().endsWith('/api/kitchen-projects/configuration') && response.request().method() === 'PUT');
    await page.getByTestId('kitchen-policy-save').click();
    expect((await conflictAgain).status()).toBe(409);
    await page.getByRole('button', { name: 'Reload current record', exact: true }).click();
    await page.getByTestId('kitchen-policy-keep-draft').click();
    await expect(page.getByTestId(`kitchen-policy-manager-${workerId}`)).toHaveAttribute('aria-pressed', 'true');
    const deliberateSave = page.waitForResponse(response => response.url().endsWith('/api/kitchen-projects/configuration') && response.request().method() === 'PUT');
    await page.getByTestId('kitchen-policy-save').click();
    const deliberate = await deliberateSave;
    expect(deliberate.request().postDataJSON().expected_version).toBe(currentAgain.version);
    expect(deliberate.ok(), await deliberate.text()).toBeTruthy();
    expect((await deliberate.json()).department_manager_user_ids).toEqual(expect.arrayContaining([managerId, workerId]));
    await health.assertHealthy();
  } finally {
    const latest = await context.request.get(`${baseURL}/api/kitchen-projects/configuration`, { headers });
    const restored = await context.request.put(`${baseURL}/api/kitchen-projects/configuration`, { headers, data: { decision_contract: '2026-10-20', expected_version: (await latest.json()).version, department_manager_user_ids: original.department_manager_user_ids || [] } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
  }
});

test('historical choices expose disabled state and cannot take keyboard focus', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await seedBrowser(page);
  const legacyId = process.env.KITCHEN_E2E_LEGACY_PROJECT_ID;
  expect(legacyId).toBeTruthy();
  await page.goto(`/kitchen/${legacyId}/stages/visit`);
  const choice = page.getByTestId('kitchen-visit-status-visited');
  await expect(choice).toBeDisabled();
  await expect(choice).toHaveAttribute('aria-disabled', 'true');
  await expect(choice).toHaveAttribute('tabindex', '-1');
  const before = await choice.getAttribute('aria-pressed');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(choice).toHaveAttribute('aria-pressed', before!);
  await health.assertHealthy();
});


test('a delayed reload cannot replace a newer committed Kitchen save', async ({ page, context }) => {
  const health = captureRuntimeHealth(page);
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer: { name: 'Kitchen reload version test', phone: `9${String(Date.now() + Math.floor(Math.random() * 1000000)).slice(-9)}` },
    lead: { site_location: 'Synthetic reload version site', notes: 'Original saved note' },
    idempotency_key: `reload-version-${Date.now()}-${Math.random()}`,
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const project = await created.json();
  await seedBrowser(page);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-project-ready')).toHaveCount(1);
  await page.getByTestId('kitchen-lead-notes').fill('Newest committed note');
  let allowSave!: () => void, saveStarted!: () => void, releaseRead!: () => void, readCaptured!: () => void;
  const saveGate = new Promise<void>(resolve => { allowSave = resolve; });
  const saveSeen = new Promise<void>(resolve => { saveStarted = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const readSeen = new Promise<void>(resolve => { readCaptured = resolve; });
  const commands = `**/api/kitchen-projects/${project.id}/commands`;
  const detail = `**/api/kitchen-projects/${project.id}`;
  await page.route(commands, async route => { saveStarted(); await saveGate; await route.continue(); });
  await page.route(detail, async route => {
    const snapshot = await route.fetch();
    expect((await snapshot.json()).version).toBe(project.version);
    readCaptured(); await readGate; await route.fulfill({ response: snapshot });
  });
  try {
    await page.getByTestId('kitchen-lead-save').click();
    await saveSeen;
    await page.getByTestId('kitchen-project-actions').click();
    await page.getByRole('menuitem', { name: 'Reload saved project', exact: true }).click();
    await readSeen;
    const committed = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'edit_lead');
    allowSave();
    const saved = await committed;
    expect(saved.ok(), await saved.text()).toBe(true);
    const latest = await saved.json();
    releaseRead();
    await expect(page.getByTestId('kitchen-project-ready')).toHaveCount(1);
    await page.unroute(commands); await page.unroute(detail);
    const nextSave = page.waitForResponse(response => response.url().endsWith('/commands'));
    await page.getByTestId('kitchen-lead-save').click();
    const next = await nextSave;
    expect(next.request().postDataJSON().expected_version).toBe(latest.version);
    expect(next.ok(), await next.text()).toBe(true);
    expect((await next.json()).lead.notes).toBe('Newest committed note');
    await health.assertHealthy();
  } finally { allowSave(); releaseRead(); await page.unroute(commands); await page.unroute(detail); }
});
