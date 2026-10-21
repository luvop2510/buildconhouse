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

test('responsive board and table retain their truthful representations through width changes', async ({ page }, testInfo) => {
  const health = captureRuntimeHealth(page);
  await seedBrowser(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/kitchen/projects?view=board');
  await expect(page.getByTestId('kitchen-board-compact')).toBeVisible();
  await expect(page.getByTestId('kitchen-board')).toContainText('Cards and column counts show this page');
  await page.getByTestId('kitchen-board-stage').click();
  await page.getByRole('menuitem', { name: 'Completed', exact: true }).click();
  await expect(page).toHaveURL(/board_stage=completed/);
  await expect(page.getByTestId('kitchen-board-group-completed')).toBeVisible();
  await expect(page.getByTestId('kitchen-board-group-lead')).toHaveCount(0);
  for (const [width, height] of [[768, 1024], [820, 1180], [844, 390], [320, 720]]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId('kitchen-board-compact')).toBeVisible();
    await expect(page.getByTestId('kitchen-board-group-completed')).toBeVisible();
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(geometry.document, `${width}×${height} root fits`).toBeLessThanOrEqual(geometry.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath(`compact-board-${width}x${height}.png`) });
  }
  await page.getByTestId('kitchen-view-menu').click();
  await page.getByRole('menuitem', { name: 'Table', exact: true }).click();
  await expect(page.getByTestId('kitchen-table')).toContainText('Every column remains visible');
  const row = page.getByRole('row').first();
  await expect(row).toContainText('Stage / status:');
  await expect(row).toContainText('Order amount:');
  await expect(row).toContainText('Target completion:');
  await expect(row).toContainText('Next action:');
  await health.assertHealthy();
});

test('stage filters use status choices and calendar inputs; aggregate cards open server-scoped queues', async ({ page, context, baseURL }, testInfo) => {
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
  await page.goto('/kitchen');
  const aggregate = await context.request.get(`${baseURL}/api/kitchen-projects/dashboard`, { headers });
  expect(aggregate.ok()).toBeTruthy();
  const dashboard = await aggregate.json();
  await page.getByTestId('kitchen-metric-active').click();
  await expect(page).toHaveURL(current => current.searchParams.get('attention') === 'active');
  const active = await context.request.get(`${baseURL}/api/kitchen-projects?attention=active`, { headers });
  expect(active.ok()).toBeTruthy();
  expect((await active.json()).total).toBe(dashboard.active_projects);
  await settle();
  await page.goto('/kitchen/workflow');
  await expect(page.getByTestId('kitchen-workflow-pending_approval')).toBeVisible();
  await page.getByTestId('kitchen-workflow-next_action_overdue').click();
  await expect(page).toHaveURL(current => current.searchParams.get('attention') === 'next_action_overdue');
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
