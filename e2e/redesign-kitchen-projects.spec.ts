import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { captureRuntimeHealth } from './runtime-health';

// This suite intentionally does not import mockSession or intercept any API.
// test-kitchen-e2e.mjs supplies a real synthetic session and actual kitchen API.
async function seedBrowser(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
}

async function projectReady(page: Page) {
  await expect(page.getByTestId('kitchen-project-ready')).toHaveCount(1);
}
async function closeProjectPanel(page: Page) {
  const panel = page.locator('[data-testid^="kitchen-"][data-testid$="-sheet"][role="dialog"]:visible');
  if (await panel.isVisible()) await panel.getByRole('button', { name: 'Close', exact: true }).click();
}
async function openProjectPage(page: Page, section: 'overview' | 'stage' | 'documents' | 'history' | 'assignments' | 'exceptions') {
  await projectReady(page);
  await closeProjectPanel(page);
  if (section === 'overview' || section === 'stage') {
    if (await page.getByTestId('kitchen-open-current-stage').isVisible()) await page.getByTestId('kitchen-open-current-stage').click();
    await expect(page.getByTestId('kitchen-current-task-region')).toBeVisible();
  } else if (section === 'exceptions') {
    await page.getByTestId('kitchen-project-actions').click();
    await page.getByRole('menuitem', { name: 'Hold, cancel or revise project', exact: true }).click();
    await expect(page.getByTestId('kitchen-exceptions-sheet')).toBeVisible();
  } else {
    const before = page.url();
    await page.getByTestId(`kitchen-project-nav-${section}`).click();
    await expect(page.getByTestId(`kitchen-${section === 'assignments' ? 'assignment' : section}-sheet`)).toBeVisible();
    await expect(page).toHaveURL(before);
  }
  await projectReady(page);
}
async function openCurrentTask(page: Page) { await openProjectPage(page, 'stage'); }

async function openDisclosure(page: Page, id: string) {
  const disclosure = page.getByTestId(`kitchen-disclose-${id}`);
  if (await disclosure.isVisible() && await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
}
async function openStageRecord(page: Page, stage: string) {
  await page.getByTestId('kitchen-open-workflow').click();
  await page.getByTestId('kitchen-workflow-sheet').getByTestId(`kitchen-stage-${stage}`).click();
  await expect(page).toHaveURL(new RegExp(`/stages/${stage}(?:\\?.*)?$`));
}

async function reviewDistinctIfNeeded(page: Page) {
  await projectReady(page);
  if (await page.getByTestId('kitchen-open-current-stage').isVisible()) await openCurrentTask(page);
  await expect(page.getByTestId('kitchen-lead-site_location')).toBeVisible();
  await projectReady(page);
  await expect(page.getByTestId('kitchen-lead-site_location')).toBeVisible();
  if (!await page.getByTestId('kitchen-duplicate-distinct').isVisible()) return;
  await expect(page.getByTestId('kitchen-convert')).toBeDisabled();
  await page.getByTestId('kitchen-duplicate-reason').fill('Owner verified a separate synthetic site');
  const reviewed = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'review_duplicate');
  await page.getByTestId('kitchen-duplicate-distinct').click();
  const response = await reviewed;
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function readyForDocuments(context: APIRequestContext, initial: any) {
  let project = initial;
  async function command(name: string, payload: Record<string, unknown> = {}) {
    const response = await context.post(`/api/kitchen-projects/${project.id}/commands`, { headers: { 'X-Floor-Id': 'second-floor' }, data: { expected_version: project.version, idempotency_key: `document-stage-${name}-${Date.now()}-${Math.random()}`, command: name, payload } });
    expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy(); project = await response.json();
  }
  if (project.duplicate_review?.status === 'pending') await command('review_duplicate', { decision: 'distinct_project', reason: 'Separate synthetic document test project' });
  await command('convert');
  await command('save_visit', { status: 'Visited', interested: true, requirements: 'Synthetic private document acceptance' });
  await command('advance_stage', { target_stage: 'cad' });
  await command('save_cad', { received: true, progress: 100, status: 'Completed' });
  await command('advance_stage', { target_stage: 'design' });
  return project;
}

test('Q01 Q02 Q03 Q12 Q13: real lead/visit persistence, manual assignment and rejected CAD gate', async ({ page, context, browser, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const customerId = process.env.KITCHEN_E2E_CUSTOMER_ID;
  const workerId = process.env.KITCHEN_E2E_WORKER_ID;
  expect(customerId, 'Runner provides its synthetic existing customer').toBeTruthy();
  expect(workerId, 'Runner provides its synthetic eligible employee').toBeTruthy();
  await seedBrowser(page);
  await page.goto('/kitchen');
  await expect(page.getByTestId('kitchen-stage-navigation')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('v4-department-overview.png') });
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByTestId('kitchen-create').click();
  const createScroll = page.getByTestId('kitchen-create-scroll');
  await expect(createScroll).toBeVisible();
  const sheetBody = await createScroll.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    paddingLeft: Number.parseFloat(getComputedStyle(element.firstElementChild!).paddingLeft),
    paddingTop: Number.parseFloat(getComputedStyle(element.firstElementChild!).paddingTop),
  }));
  expect(sheetBody.paddingLeft, 'Add Lead content has breathing room on narrow screens').toBeGreaterThanOrEqual(16);
  expect(sheetBody.paddingTop, 'Add Lead content is inset from the sheet header').toBeGreaterThanOrEqual(16);
  expect(sheetBody.scrollHeight, 'Long Add Lead forms scroll inside the sheet').toBeGreaterThan(sheetBody.clientHeight);
  await createScroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByTestId('kitchen-create-submit')).toBeInViewport();
  await createScroll.evaluate(element => { element.scrollTop = 0; });
  await page.getByTestId('kitchen-existing-customer').click();
  await page.getByTestId('kitchen-customer').fill('Kitchen acceptance customer');
  await page.getByTestId(`kitchen-customer-${customerId}`).click();
  await expect(page.getByTestId('kitchen-create-submit')).toBeDisabled();
  await page.getByTestId('kitchen-create-lead-site_location').fill('Browser synthetic site');
  await page.getByTestId('kitchen-create-lead-details-toggle').click();
  await page.getByTestId('kitchen-create-lead-notes').fill('Preserve these customer requirements');
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/kitchen-projects') && response.request().method() === 'POST');
  await page.getByTestId('kitchen-create-submit').click();
  const created = await createdResponse;
  expect(created.ok(), await created.text()).toBeTruthy();
  const project = await created.json();
  expect(project.customer_id).toBe(customerId);
  expect(project.project_reference).toBe(project.reference);
  await expect(page).toHaveURL(new RegExp(`/kitchen/${project.id}/stages/lead(?:\\?.*)?$`));
  await projectReady(page);
  await page.screenshot({ path: testInfo.outputPath('v4-project-overview.png') });
  // A second HTTP read proves the app uses the persisted canonical identity.
  const detail = await context.request.get(`${baseURL}/api/kitchen-projects/${project.id}`, { headers: { 'X-Floor-Id': 'second-floor' } });
  expect(detail.ok()).toBeTruthy();
  expect((await detail.json()).customer_id).toBe(customerId);

  await reviewDistinctIfNeeded(page);
  await page.getByTestId('kitchen-convert').click();
  await expect(page.getByTestId('kitchen-visit-save')).toBeVisible();
  await openProjectPage(page, 'assignments');
  await page.getByTestId(`kitchen-assign-${workerId}`).click();
  const assignmentResponse = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'assign');
  await page.getByTestId('kitchen-assign-save').click();
  expect((await assignmentResponse).ok()).toBeTruthy();
  await openProjectPage(page, 'stage');
  await page.getByTestId('kitchen-visit-requirements').fill('Showroom cabinets and worktop');
  await page.getByTestId('kitchen-visit-save').click();
  // Missing actual visited status/interest must fail in the authoritative API.
  await expect(page.getByTestId('kitchen-advance-cad')).toBeDisabled();
  await expect(page.getByTestId('kitchen-visit-requirements')).toHaveValue('Showroom cabinets and worktop');
  await page.reload();
  await expect(page.getByTestId('kitchen-visit-requirements')).toHaveValue('Showroom cabinets and worktop');
  const persisted = await context.request.get(`${baseURL}/api/kitchen-projects/${project.id}`, { headers: { 'X-Floor-Id': 'second-floor' } });
  expect((await persisted.json()).stage).toBe('visit');
  await page.getByTestId('kitchen-visit-status-visited').click();
  await page.getByTestId('kitchen-visit-interested-yes').click();
  await page.getByTestId('kitchen-visit-date').fill('2026-10-19');
  const savedVisit = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'save_visit');
  await page.getByTestId('kitchen-visit-save').click();
  expect((await savedVisit).ok()).toBeTruthy();
  // Both list modes read the saved Visit record and the selected worker.
  await page.goto(`/kitchen/stages/visit?search=${encodeURIComponent(project.reference)}&view=list`);
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toContainText('Kitchen acceptance worker');
  await page.getByTestId('kitchen-view-menu').click();
  await page.getByRole('menuitem', { name: 'Table', exact: true }).click();
  await expect(page.getByRole('row').filter({ has: page.getByTestId(`kitchen-project-${project.id}`) })).toContainText('Visited');
  await page.getByTestId(`kitchen-project-${project.id}`).click();
  await openCurrentTask(page);
  await expect(page.getByTestId('kitchen-visit-requirements')).toHaveValue('Showroom cabinets and worktop');
  const second = await browser.newContext({ viewport: page.viewportSize() || undefined });
  try {
    await second.addCookies([{ name: 'kitchen_acceptance_session', value: 'second', url: baseURL! }]);
    const otherPage = await second.newPage();
    const otherHealth = captureRuntimeHealth(otherPage);
    await seedBrowser(otherPage);
    await otherPage.goto(`/kitchen/${project.id}/stages/visit`);
    await expect(otherPage.getByTestId('kitchen-visit-requirements')).toHaveValue('Showroom cabinets and worktop');
    await otherHealth.assertHealthy();
  } finally { await second.close(); }
  await health.assertHealthy();
});

test('Q04 to Q09: all nine stages preserve versions, exact counters and late manager closure', async ({ page, context, browser, baseURL }, testInfo) => {
  test.setTimeout(90000); // One complete business lifecycle with ~35 persisted commands.
  const health = captureRuntimeHealth(page);
  const apiHeaders = { 'X-Floor-Id': 'second-floor' };
  const existingPolicy = await context.request.get(`${baseURL}/api/kitchen-projects/configuration`, { headers: apiHeaders });
  const policy = await context.request.put(`${baseURL}/api/kitchen-projects/configuration`, { headers: apiHeaders, data: {
    expected_version: (await existingPolicy.json()).version, decision_contract: '2026-10-20',
    department_manager_user_ids: [process.env.KITCHEN_E2E_MANAGER_ID],
  } });
  expect(policy.ok(), await policy.text()).toBeTruthy();
  await seedBrowser(page);
  await page.goto('/kitchen');
  await page.getByTestId('kitchen-create').click();
  await page.getByTestId('kitchen-existing-customer').click();
  await page.getByTestId('kitchen-customer').fill('Kitchen acceptance customer');
  await page.getByTestId(`kitchen-customer-${process.env.KITCHEN_E2E_CUSTOMER_ID}`).click();
  await page.getByTestId('kitchen-create-lead-site_location').fill('Full lifecycle synthetic site');
  const creation = page.waitForResponse(response => response.url().endsWith('/api/kitchen-projects') && response.request().method() === 'POST');
  await page.getByTestId('kitchen-create-submit').click();
  const project = await (await creation).json();
  await expect(page).toHaveURL(new RegExp(`/kitchen/${project.id}/stages/lead(?:\\?.*)?$`));
  async function click(id: string, command: string) {
    const pending = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === command);
    await page.getByTestId(id).click();
    const response = await pending;
    expect(response.ok(), `${command}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  async function blocked(id: string) {
    // UI exposes the actual server prerequisite reason and prevents the request;
    // independent API tests still exercise every malicious direct transition.
    await expect(page.getByTestId(id)).toBeDisabled();
  }
  async function approveAsManager(scope: 'production' | 'closure') {
    const manager = await browser.newContext({ viewport: page.viewportSize() || undefined });
    try {
      await manager.addCookies([{ name: 'kitchen_acceptance_session', value: 'manager', url: baseURL! }]);
      const managerPage = await manager.newPage();
      const managerHealth = captureRuntimeHealth(managerPage);
      await seedBrowser(managerPage);
      await managerPage.goto(`/kitchen/${project.id}/stages/${scope === 'production' ? 'order' : 'installation'}`);
      await openDisclosure(managerPage, `${scope}-decision`);
      const response = managerPage.waitForResponse(value => value.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && value.request().postDataJSON()?.command === 'approval');
      await managerPage.getByTestId(`kitchen-approve-${scope}`).click();
      const approved = await response;
      expect(approved.ok(), await approved.text()).toBeTruthy();
      await managerHealth.assertHealthy();
    } finally { await manager.close(); }
    if (scope === 'closure') {
      // Refresh the mounted owner provider so its completed installation draft
      // survives closure and the subsequent sibling route to Owner actions.
      const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/kitchen-projects/${project.id}`);
      await page.getByTestId('kitchen-project-actions').click();
      await page.getByRole('menuitem', { name: 'Reload saved project', exact: true }).click();
      expect((await (await refreshed).json()).stage).toBe('completed');
      await projectReady(page);
      await openProjectPage(page, 'stage');
    } else {
      await page.goto(`/kitchen/${project.id}/stages/order`);
      await projectReady(page);
    }
  }
  async function shareApprove(isDesign: boolean) {
    await page.getByTestId('kitchen-version-share-date').fill('2026-10-19');
    await click('kitchen-version-share', isDesign ? 'design_share' : 'quotation_share');
    await page.getByTestId('kitchen-version-response-approved').click();
    await click('kitchen-version-response-save', isDesign ? 'design_response' : 'quotation_response');
  }
  await reviewDistinctIfNeeded(page);
  await click('kitchen-convert', 'convert');
  await page.getByTestId('kitchen-visit-status-visited').click();
  await page.getByTestId('kitchen-visit-interested-yes').click();
  await page.getByTestId('kitchen-visit-requirements').fill('Full synthetic kitchen lifecycle');
  await click('kitchen-visit-save', 'save_visit');
  await click('kitchen-advance-cad', 'advance_stage');
  await blocked('kitchen-advance-design');
  await page.getByTestId('kitchen-cad-received-yes').click();
  await page.getByTestId('kitchen-cad-progress').fill('100');
  await page.getByTestId('kitchen-cad-status-completed').click();
  await expect(page.getByTestId('kitchen-cad-ready-yes')).toHaveCount(0);
  await click('kitchen-cad-save', 'save_cad');
  await page.screenshot({ path: testInfo.outputPath('cad-progress-only.png') });
  await openProjectPage(page, 'documents');
  await expect(page.getByTestId('kitchen-document-pick')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-document-upload')).toHaveCount(0);
  await openProjectPage(page, 'stage');
  await click('kitchen-advance-design', 'advance_stage');
  await expect(page.getByTestId('kitchen-design-handoff')).toHaveCount(0);
  await blocked('kitchen-advance-quotation');
  await page.getByTestId('kitchen-design-date').fill('2026-10-19');
  await page.getByTestId('kitchen-design-url').fill('https://example.test/synthetic-design.pdf');
  const firstDesign = await click('kitchen-design-present', 'design_present');
  expect(firstDesign.design_revision_count).toBe(0);
  await openDisclosure(page, 'design-revision');
  await page.getByTestId('kitchen-design-revision-reason').fill('Customer requests one additional cabinet');
  const requested = await click('kitchen-design-revision', 'design_revision');
  expect(requested.design_revision_count).toBe(1);
  const revised = await click('kitchen-design-present', 'design_present');
  expect(revised.design_revision_count).toBe(1);
  await shareApprove(true);
  await blocked('kitchen-advance-quotation');
  await page.getByTestId('kitchen-design-handoff-date').fill('2026-10-19');
  await click('kitchen-design-handoff', 'design_handoff');
  await click('kitchen-advance-quotation', 'advance_stage');
  await blocked('kitchen-advance-order');
  await page.getByTestId('kitchen-quotation-date').fill('2026-10-19');
  await page.getByTestId('kitchen-quotation-url').fill('https://example.test/synthetic-quotation.pdf');
  await page.getByTestId('kitchen-quotation-amount').fill('1000.01');
  await click('kitchen-quotation-receive', 'quotation_receive');
  await shareApprove(false);
  await openDisclosure(page, 'quotation-version');
  await page.getByTestId('kitchen-quotation-amount').fill('1100.01');
  const replacement = await click('kitchen-quotation-receive', 'quotation_receive');
  expect(replacement.quotation_versions[0].amount).toBe('1000.01');
  expect(replacement.quotation_versions[0].response).toBe('Approved');
  expect(replacement.quotation_versions[1].response).toBe('Pending');
  await blocked('kitchen-advance-order');
  await shareApprove(false);
  await openDisclosure(page, 'quotation-version');
  const revisedAmount = page.getByTestId('kitchen-quotation-amount');
  const savedDraftAmount = await revisedAmount.inputValue();
  await revisedAmount.fill('1200.01');
  await expect(page.getByTestId('kitchen-advance-order')).toBeDisabled();
  await expect(page.getByTestId('kitchen-advance-unsaved')).toContainText('saved, approved records');
  await revisedAmount.fill(savedDraftAmount);
  await expect(page.getByTestId('kitchen-advance-order')).toBeEnabled();
  await click('kitchen-advance-order', 'advance_stage');
  await blocked('kitchen-advance-production');
  await page.getByTestId('kitchen-order-date').fill('2026-10-19');
  await click('kitchen-order-confirm', 'order_confirm');
  await blocked('kitchen-advance-production');
  await page.getByTestId('kitchen-advance-received-yes').click();
  await page.getByTestId('kitchen-advance-amount').fill('0.01');
  await page.getByTestId('kitchen-advance-date').fill('2026-10-19');
  await click('kitchen-advance-save', 'order_advance');
  await blocked('kitchen-advance-production');
  await expect(page.getByTestId('kitchen-approve-production')).toHaveCount(0);
  await approveAsManager('production');
  await click('kitchen-advance-production', 'advance_stage');
  await blocked('kitchen-advance-installation');
  await page.getByTestId('kitchen-production-status-completed').click();
  await page.getByTestId('kitchen-production-start').fill('2026-10-19');
  await page.getByTestId('kitchen-production-complete').fill('2026-10-20');
  await click('kitchen-production-save', 'production_update');
  await click('kitchen-advance-installation', 'advance_stage');
  await blocked('kitchen-advance-completed');
  await openDisclosure(page, 'site-visit');
  await page.getByTestId('kitchen-site-date').fill('2026-10-20');
  await page.getByTestId('kitchen-site-actual-no-—-scheduled-only').click();
  const scheduled = await click('kitchen-site-save', 'site_visit');
  expect(scheduled.site_visit_count).toBe(0);
  for (let visit = 1; visit <= 2; visit++) {
    await page.getByTestId('kitchen-site-date').fill('2026-10-20');
    await page.getByTestId('kitchen-site-actual-yes-—-actual-visit').click();
    const actual = await click('kitchen-site-save', 'site_visit');
    expect(actual.site_visit_count).toBe(visit);
  }
  await page.getByTestId('kitchen-installation-status-completed').click();
  await page.getByTestId('kitchen-installation-start').fill('2026-10-20');
  await page.getByTestId('kitchen-installation-complete').fill('2026-10-21');
  const waiting = await click('kitchen-installation-save', 'installation_update');
  expect(waiting.stage).toBe('installation');
  expect(waiting.closure_pending_reason).toBeTruthy();
  await blocked('kitchen-advance-completed');
  await expect(page.getByTestId('kitchen-approve-closure')).toHaveCount(0);
  await approveAsManager('closure');
  const completedResponse = await context.request.get(`${baseURL}/api/kitchen-projects/${project.id}`, { headers: apiHeaders });
  const completed = await completedResponse.json();
  expect(completed.stage).toBe('completed');
  expect(completed.design_revision_count).toBe(1);
  expect(completed.site_visit_count).toBe(2);
  expect(completed.order_amount).toBe('1100.01');
  // Reopening must replace the retained Completed draft with the returned
  // persisted Installation state, without remounting the project provider.
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Hold, cancel or revise project', exact: true }).click();
  await expect(page.getByTestId('kitchen-exceptions-sheet')).toBeVisible();
  await page.getByTestId('kitchen-exception-reason').fill('Owner reopens the completed installation for a final adjustment');
  const reopened = await click('kitchen-exception-save', 'exception');
  expect(reopened.stage).toBe('installation');
  expect(reopened.installation.status).toBe('In Progress');
  expect(reopened.installation.completion_date).toBeNull();
  await expect(page).toHaveURL(new RegExp(`/kitchen/${project.id}/stages/installation(?:\\?.*)?$`));
  await expect(page.getByTestId('kitchen-installation-status-in-progress')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('kitchen-installation-complete')).toHaveValue('');
  await expect(page.getByTestId('kitchen-installation-start')).toHaveValue('2026-10-20');
  await openProjectPage(page, 'history');
  await openProjectPage(page, 'stage');
  await expect(page.getByTestId('kitchen-installation-status-in-progress')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('kitchen-installation-complete')).toHaveValue('');
  await page.getByTestId('kitchen-installation-status-completed').click();
  await page.getByTestId('kitchen-installation-complete').fill('2026-10-21');
  const completedAgain = await click('kitchen-installation-save', 'installation_update');
  expect(completedAgain.stage).toBe('installation');
  expect(completedAgain.closure_pending_reason).toBeTruthy();
  await approveAsManager('closure');
  const reclosed = await context.request.get(`${baseURL}/api/kitchen-projects/${project.id}`, { headers: apiHeaders });
  expect(await reclosed.json()).toMatchObject({ stage: 'completed', design_revision_count: 1, site_visit_count: 2, order_amount: '1100.01' });
  await page.reload();
  await expect(page.getByText('Total design revisions: 1', { exact: true })).toBeVisible();
  await page.goto('/kitchen/stages/completed?view=list');
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('completed-list.png') });
  await health.assertHealthy();
});

test('Q11 Q18: a stale save preserves the draft and reload allows a deliberate retry', async ({ page, context, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const headers = { 'X-Floor-Id': 'second-floor' };
  const created = await context.request.post(`${baseURL}/api/kitchen-projects`, { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID,
    idempotency_key: `browser-stale-${Date.now()}`,
    lead: { site_location: 'Stale synthetic site', notes: 'Original saved note' },
  } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const project = await created.json();
  await seedBrowser(page);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  const notes = page.getByTestId('kitchen-lead-notes');
  await expect(notes).toHaveValue('Original saved note');
  await notes.fill('Keep my unsaved draft after the conflict');
  const changed = await context.request.post(`${baseURL}/api/kitchen-projects/${project.id}/commands`, { headers, data: {
    expected_version: project.version, idempotency_key: `browser-other-${Date.now()}`,
    command: 'metadata', payload: { next_action: 'Saved by another session' },
  } });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  const stale = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'edit_lead');
  await page.getByTestId('kitchen-lead-save').click();
  expect((await stale).status()).toBe(409);
  await expect(page.getByText('This project changed', { exact: true })).toBeVisible();
  await expect(notes).toHaveValue('Keep my unsaved draft after the conflict');
  await page.screenshot({ path: testInfo.outputPath('stale-draft.png') });
  const expectedCurrent = await changed.json();
  const reloaded = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/kitchen-projects/${project.id}`);
  await page.getByRole('button', { name: 'Reload current record', exact: true }).click();
  expect((await (await reloaded).json()).version).toBe(expectedCurrent.version);
  await expect(page.getByText('Drafts retained', { exact: true })).toBeVisible();
  await expect(notes).toHaveValue('Keep my unsaved draft after the conflict');
  const retry = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'edit_lead');
  await page.getByTestId('kitchen-lead-save').click();
  const saved = await retry;
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const result = await saved.json();
  expect(result.lead.notes).toBe('Keep my unsaved draft after the conflict');
  expect(result.next_action).toBe('Saved by another session');
  await page.reload();
  await expect(notes).toHaveValue('Keep my unsaved draft after the conflict');
  await health.assertHealthy();
});

test('Q13: a lost lead cannot convert and the UI exposes no skipped-stage control', async ({ page, context, baseURL }) => {
  const health = captureRuntimeHealth(page);
  const created = await context.request.post(`${baseURL}/api/kitchen-projects`, {
    headers: { 'X-Floor-Id': 'second-floor' }, data: {
      customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID,
      idempotency_key: `browser-lost-${Date.now()}`,
      lead: { site_location: 'Lost synthetic site', status: 'Lost', lost_reason: 'Synthetic customer declined' },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const project = await created.json();
  await seedBrowser(page);
  await page.goto(`/kitchen/${project.id}`);
  await reviewDistinctIfNeeded(page);
  await expect(page.getByTestId('kitchen-convert')).toBeVisible();
  const rejected = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'convert');
  await page.getByTestId('kitchen-convert').click();
  expect((await rejected).status()).toBe(422);
  await expect(page.getByText('Could not save', { exact: true })).toBeVisible();
  await expect(page.getByTestId('kitchen-advance-order')).toHaveCount(0);
  await health.assertHealthy();
});

test('D06: owner reasoned return to Design preserves prior approved commerce and clears current eligibility', async ({ page, context, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const headers = { 'X-Floor-Id': 'second-floor' };
  const created = await context.request.post(`${baseURL}/api/kitchen-projects`, { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `late-design-${Date.now()}`,
    lead: { site_location: 'Synthetic late-change site' },
  } });
  expect(created.ok(), await created.text()).toBeTruthy();
  let project = await created.json();
  async function command(name: string, payload: Record<string, unknown> = {}, manager = false) {
    if (manager) await context.addCookies([{ name: 'kitchen_acceptance_session', value: 'manager', url: baseURL! }]);
    const response = await context.request.post(`${baseURL}/api/kitchen-projects/${project.id}/commands`, { headers, data: {
      expected_version: project.version, idempotency_key: `${name}-${Date.now()}-${Math.random()}`, command: name, payload,
    } });
    expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
    project = await response.json();
    if (manager) await context.addCookies([{ name: 'kitchen_acceptance_session', value: 'owner', url: baseURL! }]);
  }
  if (project.duplicate_review?.status === 'pending') await command('review_duplicate', { decision: 'distinct_project', reason: 'Owner verified a separate synthetic project' });
  await command('convert');
  await command('save_visit', { status: 'Visited', interested: true, requirements: 'Synthetic showroom requirements' });
  await command('advance_stage', { target_stage: 'cad' });
  await command('save_cad', { received: true, progress: 100, status: 'Completed' });
  await command('advance_stage', { target_stage: 'design' });
  await command('design_present', { presentation_date: '2026-10-19', url: 'https://example.test/synthetic-design.pdf' });
  const designId = project.design_versions.at(-1).id;
  await command('design_share', { version_id: designId, date: '2026-10-19' });
  await command('design_response', { version_id: designId, response: 'Approved' });
  await command('design_handoff', { version_id: designId, date: '2026-10-19' });
  await command('advance_stage', { target_stage: 'quotation' });
  await command('quotation_receive', { design_version_id: designId, received_date: '2026-10-19', amount: '999.99', url: 'https://example.test/synthetic-quotation.pdf' });
  const quoteId = project.quotation_versions.at(-1).id;
  await command('quotation_share', { version_id: quoteId, date: '2026-10-19' });
  await command('quotation_response', { version_id: quoteId, response: 'Approved' });
  await command('advance_stage', { target_stage: 'order' });
  await command('order_confirm', { quotation_version_id: quoteId, order_date: '2026-10-19' });
  await command('order_advance', { received: true, amount: '0.01', date: '2026-10-19' });
  await command('approval', { scope: 'production', decision: 'Approved' }, true);
  await command('advance_stage', { target_stage: 'production' });
  await seedBrowser(page);
  await context.addCookies([{ name: 'kitchen_acceptance_session', value: 'manager', url: baseURL! }]);
  await page.goto(`/kitchen/${project.id}/stages/production`);
  await expect(page.getByTestId('kitchen-project-detail')).toBeVisible();
  await expect(page.getByTestId('kitchen-return-design')).toHaveCount(0);
  await page.getByTestId('kitchen-project-actions').click();
  await expect(page.getByRole('menuitem', { name: 'Hold, cancel or revise project', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await context.addCookies([{ name: 'kitchen_acceptance_session', value: 'owner', url: baseURL! }]);
  await page.goto(`/kitchen/${project.id}/stages/production`);
  await page.getByLabel('Production notes', { exact: true }).fill('Unsaved earlier-cycle production draft');
  await expect(page.getByTestId('kitchen-unsaved-notice')).toBeVisible();
  await expect(page.getByTestId('kitchen-return-design')).toHaveCount(0);
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Hold, cancel or revise project', exact: true }).click();
  await expect(page.getByTestId('kitchen-exceptions-sheet')).toBeVisible();
  await expect(page.getByTestId('kitchen-return-design')).toBeDisabled();
  await page.getByTestId('kitchen-exception-reason').fill('Owner authorizes post-approval cabinet changes');
  const returned = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'exception');
  await page.getByTestId('kitchen-return-design').click();
  const response = await returned;
  expect(response.ok(), await response.text()).toBeTruthy();
  const revised = await response.json();
  expect(revised.stage).toBe('design');
  expect(revised.order_amount).toBeNull();
  expect(revised.orders[0].original_amount).toBe('999.99');
  expect(revised.orders[0].authorization_invalidated).toBe(true);
  expect(revised.design_versions[0].response).toBe('Approved');
  expect(revised.quotation_versions[0].response).toBe('Approved');
  await expect(page.getByTestId('kitchen-advance-quotation')).toBeDisabled();
  await expect(page.getByTestId('kitchen-design-present')).toBeDisabled();
  await page.getByTestId('kitchen-design-url').fill('https://example.test/synthetic-revised-design.pdf');
  await expect(page.getByTestId('kitchen-design-present')).toBeEnabled();
  async function saveNewCycle(testId: string, name: string) {
    const saved = page.waitForResponse(value => value.url().endsWith('/commands') && value.request().postDataJSON()?.command === name);
    await page.getByTestId(testId).click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await page.getByTestId('kitchen-design-date').fill('2026-10-19');
  await saveNewCycle('kitchen-design-present', 'design_present');
  await page.getByTestId('kitchen-version-share-date').fill('2026-10-19');
  await saveNewCycle('kitchen-version-share', 'design_share');
  await page.getByTestId('kitchen-version-response-approved').click();
  await saveNewCycle('kitchen-version-response-save', 'design_response');
  await page.getByTestId('kitchen-design-handoff-date').fill('2026-10-19');
  await saveNewCycle('kitchen-design-handoff', 'design_handoff');
  await expect(page.getByTestId('kitchen-advance-quotation')).toBeEnabled();
  await expect(page.getByTestId('kitchen-advance-unsaved')).toHaveCount(0);
  // Earlier-cycle drafts are retained for exit protection, never used by this handoff.
  await expect(page.getByTestId('kitchen-unsaved-notice')).toBeVisible();
  await expect(page.getByTestId('kitchen-exception-reason')).toHaveCount(0);
  await openProjectPage(page, 'history');
  await page.getByTestId('kitchen-history-category').click();
  await page.getByRole('menuitem', { name: 'Earlier work cycles', exact: true }).click();
  await expect(page.getByText('Earlier work cycle 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Owner authorizes post-approval cabinet changes', { exact: false })).toBeVisible();
  await page.getByTestId('kitchen-history-category').click();
  await page.getByRole('menuitem', { name: 'Orders', exact: true }).click();
  await expect(page.getByText('Historical order · Confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText(/Original ₹999\.99.*Final ₹999\.99/)).toBeVisible();
  await expect(page.getByText('Quotation version 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Confirmation document: Not attached', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-history-category').click();
  await page.getByRole('menuitem', { name: 'Design versions', exact: true }).click();
  for (const pattern of [/^Shared .+ · Kitchen acceptance owner$/, /^Sent to company .+ · Kitchen acceptance owner$/]) {
    await expect(page.getByText(pattern)).toHaveCount(2);
    for (const record of await page.getByText(pattern).all()) await expect(record).toBeVisible();
  }
  await page.getByTestId('kitchen-history-category').click();
  await page.getByRole('menuitem', { name: 'Owner changes & review', exact: true }).click();
  await expect(page.getByText('Owner authorizes post-approval cabinet changes', { exact: false })).toBeVisible();
  await openProjectPage(page, 'stage');
  await page.reload();
  await expect(page.getByTestId('kitchen-advance-quotation')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('late-design-return.png') });
  await health.assertHealthy();
});

test('D09: legacy completed records show unavailable counts and blank historical dates in list and detail', async ({ page, context, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const projectId = process.env.KITCHEN_E2E_LEGACY_PROJECT_ID;
  expect(projectId, 'Harness seeds one explicit synthetic legacy row without runtime import').toBeTruthy();
  await seedBrowser(page);
  await page.goto('/kitchen/stages/completed?view=list');
  const card = page.getByTestId(`kitchen-project-${projectId}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Historical count unavailable');
  await expect(card).not.toContainText('Design revisions 0');
  await expect(card).not.toContainText('Actual site visits 0');
  await card.click();
  await expect(page.getByText('Legacy project', { exact: false })).toBeVisible();
  await openCurrentTask(page);
  await expect(page.getByText(/^Total design revisions: Historical count unavailable(?: · Newly recorded: 0)?$/)).toBeVisible();
  await expect(page.getByText(/^Actual site visits: Historical count unavailable(?: · Newly recorded: 0)?$/)).toBeVisible();
  await openStageRecord(page, 'lead');
  await expect(page.getByTestId('kitchen-lead-date')).toHaveValue('');
  await openStageRecord(page, 'installation');
  await expect(page.getByText('Saved start: — · Saved completion: —', { exact: true })).toBeVisible();
  const legacyRecord = await context.request.get(`${baseURL}/api/kitchen-projects/${projectId}`, { headers: { 'X-Floor-Id': 'second-floor' } });
  const legacy = await legacyRecord.json();
  expect(legacy.installation.start_date).toBeNull();
  expect(legacy.installation.completion_date).toBeNull();
  await page.screenshot({ path: testInfo.outputPath('legacy-unknown-counts.png') });
  // Any assigned stage preserves authorized history reads; unrelated projects
  // stay absent for the ordinary employee under the same actual session path.
  await context.addCookies([{ name: 'kitchen_acceptance_session', value: 'worker', url: baseURL! }]);
  await page.reload();
  await expect(page.getByTestId('kitchen-project-detail')).toBeVisible();
  await expect(page.getByTestId('kitchen-exception-save')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-assign-save')).toHaveCount(0);
  const detail = await context.request.get(`${baseURL}/api/kitchen-projects/${projectId}`, { headers: { 'X-Floor-Id': 'second-floor' } });
  expect(detail.ok()).toBeTruthy();
  expect((await detail.json()).site_visit_count).toBeNull();
  await health.assertHealthy();
});

test('D10 Q22: original selected file uploads privately and authorized download returns exact bytes', async ({ page, context, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const headers = { 'X-Floor-Id': 'second-floor' };
  const created = await context.request.post(`${baseURL}/api/kitchen-projects`, { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID,
    idempotency_key: `private-document-${Date.now()}`, lead: { site_location: 'Synthetic document site' },
  } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const project = await readyForDocuments(context.request, await created.json());
  await seedBrowser(page);
  await page.goto(`/kitchen/${project.id}/stages/design`);
  await openProjectPage(page, 'documents');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('kitchen-document-pick').click();
  const content = Buffer.from('%PDF-1.4\nSynthetic private document from the actual browser picker\n%%EOF');
  await (await chooser).setFiles({ name: 'synthetic-private.pdf', mimeType: 'application/pdf', buffer: content });
  const upload = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/attachments`) && response.request().method() === 'POST');
  await page.getByTestId('kitchen-document-upload').click();
  const uploaded = await upload;
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const saved = await uploaded.json();
  expect(saved.attachments).toHaveLength(1);
  expect(saved.attachments[0].storage_key).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Download synthetic-private.pdf', exact: true })).toBeVisible();
  const file = await context.request.get(`${baseURL}/api/kitchen-projects/${project.id}/attachments/${saved.attachments[0].id}`, { headers });
  expect(file.ok()).toBeTruthy();
  expect(await file.body()).toEqual(content);
  expect(file.headers()['cache-control']).toBe('no-store');
  const unrelated = await context.request.get(`${baseURL}/api/kitchen-projects/${process.env.KITCHEN_E2E_LEGACY_PROJECT_ID}/attachments/${saved.attachments[0].id}`, { headers });
  expect(unrelated.status()).toBe(404);
  await page.screenshot({ path: testInfo.outputPath('private-document.png') });
  await health.assertHealthy();
});

test('Q18 v4: project pages separate work from files and history while preserving unsaved task drafts', async ({ page, context, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const headers = { 'X-Floor-Id': 'second-floor' };
  const creation = await context.request.post(`${baseURL}/api/kitchen-projects`, { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `v4-drafts-${Date.now()}`,
    lead: { site_location: 'Page navigation synthetic site', notes: 'Saved enquiry baseline' },
  } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  let project = await creation.json();
  await seedBrowser(page);
  await page.goto(`/kitchen/${project.id}`);
  // Summary is a distinct place to orient, with no editing or upload form.
  await expect(page.getByTestId('kitchen-current-task-region')).toBeVisible();
  await expect(page.getByTestId('kitchen-document-pick')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-exception-reason')).toHaveCount(0);
  await openCurrentTask(page);
  const notes = page.getByTestId('kitchen-lead-notes');
  await notes.fill('Unsaved enquiry retained across project tools');
  await expect(page.getByTestId('kitchen-project-nav-documents')).toBeVisible();
  await openProjectPage(page, 'history');
  await expect(page.getByTestId('kitchen-history-sheet')).toBeVisible();
  await expect(page.getByTestId('kitchen-history-category')).toBeVisible();
  await expect(page.getByTestId('kitchen-document-pick')).toHaveCount(0);
  await openProjectPage(page, 'stage');
  await expect(notes).toHaveValue('Unsaved enquiry retained across project tools');
  const savedLead = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'edit_lead');
  await page.getByTestId('kitchen-lead-save').click();
  const saved = await savedLead;
  expect(saved.ok(), await saved.text()).toBeTruthy();
  project = await saved.json();
  expect(project.lead.notes).toBe('Unsaved enquiry retained across project tools');
  async function command(name: string, payload: Record<string, unknown> = {}) {
    const response = await context.request.post(`${baseURL}/api/kitchen-projects/${project.id}/commands`, { headers, data: {
      expected_version: project.version, idempotency_key: `drafts-${name}-${Date.now()}-${Math.random()}`, command: name, payload,
    } });
    expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
    project = await response.json();
  }
  if (project.duplicate_review?.status === 'pending') await command('review_duplicate', { decision: 'distinct_project', reason: 'Owner verified distinct navigation acceptance site' });
  await command('convert');
  await command('save_visit', { status: 'Visited', interested: true, requirements: 'Kitchen design for navigation acceptance' });
  await command('advance_stage', { target_stage: 'cad' });
  await command('save_cad', { received: true, progress: 100, status: 'Completed' });
  await command('advance_stage', { target_stage: 'design' });
  await page.goto(`/kitchen/${project.id}/stages/design`);
  await page.getByTestId('kitchen-design-date').fill('2026-10-20');
  await page.getByTestId('kitchen-design-url').fill('https://example.com/synthetic-draft-design');
  await page.getByRole('textbox', { name: 'Design notes', exact: true }).fill('Unsaved design presentation survives navigation');
  await openProjectPage(page, 'documents');
  await openProjectPage(page, 'history');
  await openProjectPage(page, 'assignments');
  await expect(page.getByTestId('kitchen-assign-save')).toBeVisible();
  await expect(page.getByTestId('kitchen-assignment-sheet')).toBeVisible();
  await openProjectPage(page, 'stage');
  await expect(page.getByTestId('kitchen-design-date')).toHaveValue('2026-10-20');
  await expect(page.getByTestId('kitchen-design-url')).toHaveValue('https://example.com/synthetic-draft-design');
  await expect(page.getByRole('textbox', { name: 'Design notes', exact: true })).toHaveValue('Unsaved design presentation survives navigation');
  await expect(page.getByTestId('kitchen-document-pick')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-history-category')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-exception-reason')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-metadata-save')).toHaveCount(0);
  const presentResponse = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'design_present');
  await page.getByTestId('kitchen-design-present').click();
  const presented = await presentResponse;
  expect(presented.ok(), await presented.text()).toBeTruthy();
  const stored = await presented.json();
  expect(stored.design_versions.at(-1)).toMatchObject({ presentation_date: '2026-10-20', url: 'https://example.com/synthetic-draft-design', notes: 'Unsaved design presentation survives navigation' });
  expect(stored.design_revision_count).toBe(0);
  const persisted = await context.request.get(`${baseURL}/api/kitchen-projects/${project.id}`, { headers });
  expect((await persisted.json()).design_versions.at(-1).notes).toBe('Unsaved design presentation survives navigation');
  await page.screenshot({ path: testInfo.outputPath('v4-focused-design-task.png') });
  await health.assertHealthy();
});

test('Q02 Q18 Q19 v4: stage queues deep-link correctly and project Back restores the selected list query', async ({ page, context, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const headers = { 'X-Floor-Id': 'second-floor' };
  const creation = await context.request.post(`${baseURL}/api/kitchen-projects`, { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `v4-queue-${Date.now()}`, lead: { site_location: 'Stage queue synthetic site' },
  } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  const project = await creation.json();
  await seedBrowser(page);
  const stageRead = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/kitchen-projects' && new URL(response.url()).searchParams.get('stage') === 'lead');
  await page.goto('/kitchen/stages/lead');
  await expect(page.getByTestId('kitchen-stage-navigation')).toBeVisible();
  const queue = await stageRead;
  expect(queue.ok(), await queue.text()).toBeTruthy();
  expect((await queue.json()).rows.every((row: { stage: string }) => row.stage === 'lead')).toBe(true);
  await page.getByTestId('kitchen-search').fill(project.reference);
  await expect(page).toHaveURL(new RegExp(`/kitchen/stages/lead\\?[^#]*search=${project.reference}`));
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('v4-lead-stage-queue.png') });
  const stageURL = page.url();
  await page.reload();
  await expect(page.getByTestId('kitchen-search')).toHaveValue(project.reference);
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toBeVisible();
  await expect(page).toHaveURL(stageURL);
  const origin = `/kitchen/stages/lead?search=${encodeURIComponent(project.reference)}&sort=reference&direction=asc&view=list&page=1`;
  await page.goto(origin);
  await page.getByTestId(`kitchen-project-${project.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/kitchen/${project.id}/stages/lead\\?returnTo=`));
  await openCurrentTask(page);
  await openProjectPage(page, 'history');
  await openProjectPage(page, 'overview');
  await page.goto(origin);
  await page.getByTestId(`kitchen-project-${project.id}`).click();
  await projectReady(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(current => current.pathname === '/kitchen/stages/lead');
  const restored = new URL(page.url());
  const expectedOrigin = new URL(origin, baseURL);
  expect([...restored.searchParams.entries()].sort()).toEqual([...expectedOrigin.searchParams.entries()].sort());
  await expect(page.getByTestId('kitchen-search')).toHaveValue(project.reference);
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('v4-project-list-context.png') });
  await health.assertHealthy();
});

test('Q18: dirty scope guards global navigation, programmatic Back and browser unload while preserving siblings', async ({ page, context, baseURL }, info) => {
  const health = captureRuntimeHealth(page);
  const headers = { 'X-Floor-Id': 'second-floor' };
  const response = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `guard-${Date.now()}`,
    lead: { site_location: 'Independent dirty exit site', notes: 'Saved guard baseline' },
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = await response.json();
  await seedBrowser(page);
  const origin = `/kitchen/stages/lead?search=${project.reference}&view=list`;
  await page.goto(origin);
  await page.getByTestId(`kitchen-project-${project.id}`).click();
  await openCurrentTask(page);
  const notes = page.getByTestId('kitchen-lead-notes');
  await notes.fill('Unsaved guard draft');
  await expect(page.getByTestId('kitchen-unsaved-notice')).toBeVisible();
  const dialogs: string[] = [];
  const dismiss = async (dialog: import('@playwright/test').Dialog) => { dialogs.push(dialog.type()); await dialog.dismiss(); };
  page.on('dialog', dismiss);
  await openProjectPage(page, 'history');
  await openProjectPage(page, 'stage');
  await expect(notes).toHaveValue('Unsaved guard draft');
  expect(dialogs, 'Sibling pages retain drafts without exit confirmation').toEqual([]);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(current => current.pathname === `/kitchen/${project.id}/stages/lead`);
  await expect(notes).toHaveValue('Unsaved guard draft');
  const global = page.locator('a[href="/kitchen/stages/lead"]:visible').first();
  await global.click();
  await expect.poll(() => dialogs.length).toBe(2);
  await expect(notes).toHaveValue('Unsaved guard draft');
  await page.goBack();
  await expect.poll(() => dialogs.length).toBe(3);
  await expect(page).toHaveURL(current => current.pathname === `/kitchen/${project.id}/stages/lead`);
  await expect(notes).toHaveValue('Unsaved guard draft');
  const unload = page.waitForEvent('dialog', { predicate: dialog => dialog.type() === 'beforeunload' });
  // A deliberately canceled reload has no completed navigation to await.
  await page.evaluate(() => { window.location.reload(); });
  await unload;
  await expect.poll(() => dialogs.includes('beforeunload')).toBe(true);
  await expect(notes).toHaveValue('Unsaved guard draft');
  const saved = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().postDataJSON()?.command === 'edit_lead');
  await page.getByTestId('kitchen-lead-save').click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByTestId('kitchen-unsaved-notice')).toHaveCount(0);
  page.off('dialog', dismiss);
  await page.reload();
  await expect(notes).toHaveValue('Unsaved guard draft');
  await health.assertHealthy();
  await info.attach('dirty-scope-dialogs', { contentType: 'application/json', body: JSON.stringify({ dialogs, engine: info.project.name, viewport: page.viewportSize() }) });
});

test('Q18: clean Back and Forward traverse history and a direct project link uses a validated fallback', async ({ page, context, browser, baseURL }) => {
  const health = captureRuntimeHealth(page);
  const response = await context.request.post('/api/kitchen-projects', { headers: { 'X-Floor-Id': 'second-floor' }, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `history-${Date.now()}`, lead: { site_location: 'Independent history site' },
  } });
  const project = await response.json();
  await seedBrowser(page);
  const origin = `/kitchen/stages/lead?search=${project.reference}&view=list`;
  await page.goto(origin); await page.getByTestId(`kitchen-project-${project.id}`).click(); await projectReady(page);
  const projectURL = page.url();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(current => current.pathname === '/kitchen/stages/lead');
  await page.goForward(); await expect(page).toHaveURL(projectURL); await projectReady(page);
  await health.assertHealthy();
  const direct = await browser.newContext({ viewport: page.viewportSize() || undefined });
  try {
    const directPage = await direct.newPage(); const directHealth = captureRuntimeHealth(directPage); await seedBrowser(directPage);
    await directPage.goto(`${baseURL}/kitchen/${project.id}?returnTo=${encodeURIComponent('https://untrusted.example/')}`);
    await projectReady(directPage); await directPage.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(directPage).toHaveURL(current => current.origin === baseURL && current.pathname === '/kitchen/stages/lead');
    await directHealth.assertHealthy();
  } finally { await direct.close(); }
});

test('Q18: New Lead cancellation protects entered fields and explicit discard does not leak into another lead', async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  await seedBrowser(page); await page.goto('/kitchen/stages/lead');
  await page.getByTestId('kitchen-create').click();
  await page.getByTestId('kitchen-customer-name').fill('New enquiry');
  await page.getByTestId('kitchen-customer-phone').fill('9000000011');
  await page.getByTestId('kitchen-create-lead-site_location').fill('Unsaved new lead draft');
  const original = page.url();
  const dismissed = page.waitForEvent('dialog').then(async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.dismiss(); });
  await page.getByTestId('kitchen-create-sheet').getByRole('button', { name: 'Close', exact: true }).click(); await dismissed;
  await expect(page).toHaveURL(original);
  await expect(page.getByTestId('kitchen-create-lead-site_location')).toHaveValue('Unsaved new lead draft');
  const accepted = page.waitForEvent('dialog').then(async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.accept(); });
  await page.getByTestId('kitchen-create-sheet').getByRole('button', { name: 'Close', exact: true }).click(); await accepted;
  await expect(page.getByTestId('kitchen-create-sheet')).not.toBeVisible();
  await page.getByTestId('kitchen-create').click();
  await expect(page.getByTestId('kitchen-customer-name')).toHaveValue('');
  await expect(page.getByTestId('kitchen-customer-phone')).toHaveValue('');
  await expect(page.getByTestId('kitchen-create-lead-site_location')).toHaveValue('');
  await health.assertHealthy();
  await page.screenshot({ path: info.outputPath('new-lead-discarded.png') });
});

test('D10: private large-file upload resumes after interruption and downloads verified bounded parts', async ({ page, context }, info) => {
  test.setTimeout(90000);
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const health = captureRuntimeHealth(page);
  const response = await context.request.post('/api/kitchen-projects', { headers: { 'X-Floor-Id': 'second-floor' }, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `large-${Date.now()}`, lead: { site_location: 'Synthetic large design presentation site' },
  } });
  expect(response.ok()).toBeTruthy();
  const project = await readyForDocuments(context.request, await response.json());
  const size = info.project.name === 'kitchen-desktop' ? 25_000_000 : 3_000_000;
  const bytes = Buffer.alloc(size, 65); bytes.write('%PDF-1.4');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await seedBrowser(page); await page.goto(`/kitchen/${project.id}/documents`);
  let interrupted = false;
  await page.route('**/file-transfers/*/parts/2', async route => {
    if (!interrupted && route.request().method() === 'PUT') { interrupted = true; return route.abort('failed'); }
    return route.continue();
  });
  const envelopes: number[] = [];
  page.on('request', request => { if (request.url().includes('/file-transfers/')) envelopes.push(request.postDataBuffer()?.length || 0); });
  const picker = page.waitForEvent('filechooser');
  await page.getByTestId('kitchen-document-pick').click();
  await (await picker).setFiles({ name: 'synthetic-large.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.getByTestId('kitchen-document-upload').click();
  await expect(page.getByText('Could not save', { exact: true })).toBeVisible();
  expect(interrupted).toBe(true);
  const before = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers: { 'X-Floor-Id': 'second-floor' } });
  expect((await before.json()).attachments).toHaveLength(0);
  await expect(page.getByTestId('kitchen-document-upload')).toBeEnabled();
  const finished = page.waitForResponse(r => r.url().endsWith('/finish') && r.request().method() === 'POST');
  await page.getByTestId('kitchen-document-upload').click();
  const saved = await finished;
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const canonical = await saved.json();
  expect(canonical.attachments).toHaveLength(1);
  expect(canonical.attachments[0].sha256).toBe(sha256);
  expect(canonical.attachments[0].size_bytes).toBe(size);
  expect(envelopes.every(length => length < 1024 * 1024)).toBe(true);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download synthetic-large.pdf', exact: true }).click();
  if (await page.getByTestId('mobile-file-save').isVisible()) await page.getByTestId('mobile-file-download').click();
  // Mobile file preparation is asynchronous; wait for the fresh save sheet.
  else if (info.project.name !== 'kitchen-desktop') { await expect(page.getByTestId('mobile-file-save')).toBeVisible(); await page.getByTestId('mobile-file-download').click(); }
  const download = await downloading;
  expect(createHash('sha256').update(await readFile((await download.path())!)).digest('hex')).toBe(sha256);
  await health.assertHealthy();
  await info.attach('large-file-transfer', { contentType: 'application/json', body: JSON.stringify({ profile: info.project.name, sizeBytes: size, sha256, interrupted, maximumRequestBytes: Math.max(...envelopes), provider: 'owned-local-private-bytes', hosted: false }) });
});
