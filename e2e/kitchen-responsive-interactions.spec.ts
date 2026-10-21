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
  const converted = page.waitForResponse(response => response.request().postDataJSON()?.command === 'convert');
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
  await expect(row).toContainText('Next action:');
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
