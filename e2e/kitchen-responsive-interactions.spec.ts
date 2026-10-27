import { projectControl, expandProjectDetails } from './kitchen-controls';
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
  await expect(page.getByTestId('kitchen-filters-open')).toHaveCount(0);
  const created = await context.request.post('/api/kitchen-projects', { headers, data: { customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `panel-scroll-${Date.now()}-${Math.random()}`, lead: { site_location: 'Panel reachability check' } } });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await (await projectControl(page, 'kitchen-project-actions')).click();
  await page.getByRole('menuitem', { name: 'Stage history', exact: true }).click();
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
  await (await projectControl(page, 'kitchen-project-actions')).click();
  await page.getByRole('menuitem', { name: 'Edit customer', exact: true }).click();
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
  await expandProjectDetails(page);
  await expect(page.getByText(`${name} · ${phone}`, { exact: true })).toBeVisible();
  const converted = page.waitForResponse(response => response.request().postDataJSON()?.command === 'move_stage');
  await (await projectControl(page, 'kitchen-convert')).click();
  const visit = await (await converted).json();
  expect(visit).toMatchObject({ id: project.id, customer_id: project.customer_id, stage: 'visit' });
  const reused = await context.request.post('/api/kitchen-projects', { headers, data: { customer: { name: 'Do not overwrite this existing customer', phone: `+91 ${phone}` }, idempotency_key: `inline-reuse-${Date.now()}-${Math.random()}`, lead: { site_location: 'Second synthetic location' } } });
  expect(reused.ok(), await reused.text()).toBe(true);
  expect(await reused.json()).toMatchObject({ customer_id: project.customer_id, customer: { name }, stage: 'lead', duplicate_review: { status: 'pending' } });
  await health.assertHealthy();
});

test('retired view bookmarks use the compact list through width changes', async ({ page, context }, testInfo) => {
  const created = await context.request.post('/api/kitchen-projects', { headers, data: { customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `responsive-board-${Date.now()}-${Math.random()}`, lead: { site_location: 'Independent responsive board site' } } });
  expect(created.ok(), await created.text()).toBe(true);
  const health = captureRuntimeHealth(page);
  await seedBrowser(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/kitchen/stages/lead?view=board');
  await expect(page.getByTestId('kitchen-compact-list')).toBeVisible();
  await expect(page.getByTestId('kitchen-view-menu')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-board')).toHaveCount(0);
  for (const [width, height] of [[1280, 900], [768, 1024], [820, 1180], [844, 390], [320, 720]]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId('kitchen-compact-list')).toBeVisible();
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(geometry.document, `${width}×${height} root fits`).toBeLessThanOrEqual(geometry.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath(`compact-list-${width}x${height}.png`) });
  }
  await page.goto('/kitchen/stages/lead?view=table');
  const list = page.getByTestId('kitchen-compact-list');
  await expect(list).toBeVisible();
  await expect(page.getByTestId('kitchen-table')).toHaveCount(0);
  for (const label of ['Phone', 'Site location', 'Budget']) await expect(list).toContainText(label);
  await health.assertHealthy();
});

test('Kitchen has no filters and navigation stays within the nine queues', async ({ page }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const pending = new Set<import('@playwright/test').Request>();
  let activity = Date.now();
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) { pending.add(request); activity = Date.now(); } });
  const finished = (request: import('@playwright/test').Request) => { if (pending.delete(request)) activity = Date.now(); };
  page.on('requestfinished', finished); page.on('requestfailed', finished);
  const settle = () => expect.poll(() => pending.size === 0 && Date.now() - activity >= 150, { timeout: 10000 }).toBe(true);
  await seedBrowser(page);
  await page.goto('/kitchen/stages/visit');
  await expect(page.getByTestId('kitchen-filters-open')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-status-filter')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-date-from')).toHaveCount(0);
  const queueRead = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/kitchen-projects' && new URL(response.url()).searchParams.get('stage') === 'design');
  await expect(page.getByTestId('kitchen-stage-navigation')).toHaveCount(0);
  await page.getByTestId('kitchen-dashboard-link').click();
  await page.getByTestId('kitchen-dashboard-stage-design').click();
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
    await (await projectControl(page, 'kitchen-project-actions')).click();
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


test('Kitchen mobile input and blur taps preserve the form viewport and select the first time', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID,
    idempotency_key: `mobile-blur-geometry-${Date.now()}-${Math.random()}`,
    lead: { site_location: 'Mobile form position check' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const project = await created.json();
  await seedBrowser(page);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-project-ready')).toHaveCount(1);
  const field = page.getByTestId('kitchen-lead-site_location');
  await field.scrollIntoViewIfNeeded();
  const scroll = page.getByTestId('kitchen-page-scroll');
  const before = await scroll.boundingBox();
  const restingField = await field.boundingBox();
  await field.fill('Entered value remains in place');
  await expect(page.getByTestId('mobile-workspace-header')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeHidden();
  const editingViewport = await scroll.boundingBox();
  expect(editingViewport!.y, 'Focusing keeps the form top anchored').toBe(before!.y);
  expect(editingViewport!.height, 'Hidden navigation gives its space to the form').toBeGreaterThan(before!.height);
  const inputBeforeBlur = await field.boundingBox();
  expect(Math.abs(inputBeforeBlur!.y - restingField!.y), 'Typing the first dirty value must not move the field').toBeLessThan(2);
  await page.getByText('Site location (required)', { exact: true }).click();
  await expect(page.getByTestId('mobile-workspace-header')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
  await expect.poll(() => scroll.boundingBox(), { message: 'Dismissal restores the resting viewport after the tap settles' }).toEqual(before);
  expect(Math.abs((await field.boundingBox())!.y - inputBeforeBlur!.y), 'A tap outside the input keeps its vertical position').toBeLessThan(2);
  await expect(field).toHaveValue('Entered value remains in place');
  // Model the reduced usable browser height while a phone keyboard is open.
  await page.setViewportSize({ width: 390, height: 550 });
  await field.focus();
  await field.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('mobile-workspace-header')).toBeVisible();
  expect((await scroll.boundingBox())!.height, 'The keyboard viewport retains a usable form area').toBeGreaterThan(300);
  await page.screenshot({ path: info.outputPath('mobile-form-short-editing-viewport.png') });
  await field.blur();
  await expect(page.getByTestId('mobile-workspace-header')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const status = page.getByTestId('kitchen-lead-status-contacted');
  await status.scrollIntoViewIfNeeded();
  await field.fill('Value immediately before the status tap');
  await status.click();
  await expect(status).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mobile-workspace-header')).toBeVisible();
  await page.screenshot({ path: info.outputPath('mobile-form-stable-after-blur.png') });
  const saved = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'edit_lead');
  await page.getByTestId('kitchen-lead-save').click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).lead).toMatchObject({ site_location: 'Value immediately before the status tap', status: 'Contacted' });
});
