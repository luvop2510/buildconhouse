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
  await expect(page.getByTestId('kitchen-convert')).toBeEnabled();
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

test('Q01 Q02 Q03 Q12 Q13: real lead/visit persistence, automatic editable dates and rejected CAD gate', async ({ page, context, browser, baseURL }, testInfo) => {
  const health = captureRuntimeHealth(page);
  const customerId = process.env.KITCHEN_E2E_CUSTOMER_ID;
  expect(customerId, 'Runner provides its synthetic existing customer').toBeTruthy();
  await seedBrowser(page);
  await page.goto('/kitchen');
  await expect(page.getByTestId('kitchen-stage-navigation')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('v4-department-overview.png') });
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByTestId('kitchen-create').click();
  const createScroll = page.getByTestId('kitchen-create-sheet-scroll');
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
  const panelBounds = await page.getByTestId('kitchen-create-sheet').boundingBox();
  const fieldBounds = await page.getByTestId('kitchen-customer-name').boundingBox();
  expect(fieldBounds!.x - panelBounds!.x, 'The actual input is inset from the panel edge').toBeGreaterThanOrEqual(16);
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
  const indiaToday = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  await expect(page.getByTestId('kitchen-visit-date')).toHaveValue(indiaToday);
  await expect(page.getByTestId('kitchen-assignee')).toBeVisible();
  await expect(page.getByTestId('kitchen-visit-next-action')).toHaveCount(0);
  await openProjectPage(page, 'assignments');
  await expect(page.getByTestId('kitchen-assign-save')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-meta-next-action')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-target-date')).toBeVisible();
  await openProjectPage(page, 'stage');
  await page.getByTestId('kitchen-visit-notes').fill('Showroom cabinets and worktop');
  await page.getByTestId('kitchen-visit-save').click();
  // Stage navigation stays available before recording an actual visit.
  await expect(page.getByTestId('kitchen-advance-cad')).toBeEnabled();
  await expect(page.getByTestId('kitchen-visit-notes')).toHaveValue('Showroom cabinets and worktop');
  await page.reload();
  await expect(page.getByTestId('kitchen-visit-notes')).toHaveValue('Showroom cabinets and worktop');
  const persisted = await context.request.get(`${baseURL}/api/kitchen-projects/${project.id}`, { headers: { 'X-Floor-Id': 'second-floor' } });
  expect((await persisted.json()).stage).toBe('visit');
  await page.getByTestId('kitchen-visit-status-visited').click();
  await page.getByTestId('kitchen-visit-display-gi').click();
  await page.getByTestId('kitchen-visit-date').fill('2026-10-19');
  const savedVisit = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'save_visit');
  await page.getByTestId('kitchen-visit-save').click();
  expect((await savedVisit).ok()).toBeTruthy();
  // Retired view bookmarks preserve the same saved Visit record in the compact list.
  await page.goto(`/kitchen/stages/visit?search=${encodeURIComponent(project.reference)}&view=list`);
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toContainText('Visited');
  await page.goto(`/kitchen/stages/visit?search=${encodeURIComponent(project.reference)}&view=table`);
  await expect(page.getByTestId(`kitchen-project-${project.id}`)).toContainText('Visited');
  await expect(page.getByTestId('kitchen-view-menu')).toHaveCount(0);
  await page.getByTestId(`kitchen-project-${project.id}`).click();
  await openCurrentTask(page);
  await expect(page.getByTestId('kitchen-visit-notes')).toHaveValue('Showroom cabinets and worktop');
  const second = await browser.newContext({ viewport: page.viewportSize() || undefined });
  try {
    await second.addCookies([{ name: 'kitchen_acceptance_session', value: 'second', url: baseURL! }]);
    const otherPage = await second.newPage();
    const otherHealth = captureRuntimeHealth(otherPage);
    await seedBrowser(otherPage);
    await otherPage.goto(`/kitchen/${project.id}/stages/visit`);
    await expect(otherPage.getByTestId('kitchen-visit-notes')).toHaveValue('Showroom cabinets and worktop');
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
    const actualCommand = command === 'convert' || command === 'advance_stage' ? 'move_stage' : command;
    const pending = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === actualCommand);
    await page.getByTestId(id).click();
    const response = await pending;
    expect(response.ok(), `${command}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  async function blocked(id: string) {
    // Navigation remains available regardless of incomplete business details.
    await expect(page.getByTestId(id)).toBeEnabled();
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
      expect((await (await refreshed).json()).stage).toBe('installation');
      await projectReady(page);
      await openProjectPage(page, 'stage');
      await click('kitchen-advance-completed', 'advance_stage');
    } else {
      await page.goto(`/kitchen/${project.id}/stages/order`);
      await projectReady(page);
    }
  }
  async function shareApprove(isDesign: boolean) {
    await page.getByTestId('kitchen-version-share-date').fill('2026-10-19');
    await click('kitchen-version-share', isDesign ? 'design_share' : 'quotation_share');
    await page.getByTestId('kitchen-version-response-approved').click();
    if (isDesign) await page.getByTestId('kitchen-design-approval-date').fill('2026-10-19');
    await click('kitchen-version-response-save', isDesign ? 'design_response' : 'quotation_response');
  }
  await reviewDistinctIfNeeded(page);
  await click('kitchen-convert', 'convert');
  await page.getByTestId('kitchen-visit-status-visited').click();
  await page.getByTestId('kitchen-visit-display-gi').click();
  await page.getByTestId('kitchen-visit-notes').fill('Full synthetic kitchen lifecycle');
  await click('kitchen-visit-save', 'save_visit');
  await click('kitchen-advance-cad', 'advance_stage');
  await blocked('kitchen-advance-design');
  await page.getByTestId('kitchen-cad-received-yes').click();
  await page.getByTestId('kitchen-cad-progress').fill('100');
  await expect(page.getByTestId('kitchen-cad-status')).toContainText('Completed');
  await expect(page.getByTestId('kitchen-cad-ready-yes')).toHaveCount(0);
  await click('kitchen-cad-save', 'save_cad');
  await page.screenshot({ path: testInfo.outputPath('cad-progress.png') });
  await openProjectPage(page, 'documents');
  await expect(page.getByTestId('kitchen-document-pick')).toBeEnabled();
  await expect(page.getByTestId('kitchen-document-upload')).toHaveCount(0);
  await openProjectPage(page, 'stage');
  await click('kitchen-advance-design', 'advance_stage');
  await expect(page.getByTestId('kitchen-design-handoff')).toHaveCount(0);
  await blocked('kitchen-advance-quotation');
  await page.getByTestId('kitchen-design-date').fill('2026-10-19');
  await expect(page.getByTestId('kitchen-design-url')).toHaveCount(0);
  await page.getByTestId('kitchen-design-requirements').fill('Full synthetic kitchen lifecycle');
  await page.getByTestId('kitchen-design-budget').fill('Within the agreed project budget');
  const firstDesign = await click('kitchen-design-present', 'design_present');
  expect(firstDesign.design_revision_count).toBe(0);
  await openDisclosure(page, 'design-edit');
  await page.getByTestId('kitchen-design-edit-notes').fill('Customer requests one additional cabinet');
  const requested = await click('kitchen-design-revision', 'design_revision');
  expect(requested.design_revision_count).toBe(1);
  await page.getByTestId('kitchen-design-date').fill('2026-10-19');
  const revised = await click('kitchen-design-present', 'design_present');
  expect(revised.design_revision_count).toBe(1);
  await shareApprove(true);
  await blocked('kitchen-advance-quotation');
  await page.getByTestId('kitchen-design-handoff-date').fill('2026-10-19');
  await click('kitchen-design-handoff', 'design_handoff');
  await click('kitchen-advance-quotation', 'advance_stage');
  await blocked('kitchen-advance-order');
  await page.getByTestId('kitchen-quotation-date').fill('2026-10-19');
  await expect(page.getByTestId('kitchen-quotation-url')).toHaveCount(0);
  await openProjectPage(page, 'documents');
  const quotationPicker = page.waitForEvent('filechooser');
  await page.getByTestId('kitchen-document-pick').click();
  await (await quotationPicker).setFiles({ name: 'company-quotation.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nSynthetic quotation\n%%EOF') });
  const quotationUpload = page.waitForResponse(response => response.url().endsWith('/attachments') && response.request().method() === 'POST');
  await page.getByTestId('kitchen-document-upload').click();
  expect((await quotationUpload).ok()).toBeTruthy();
  await openProjectPage(page, 'stage');
  await page.getByTestId('kitchen-quotation-amount').fill('1000.01');
  await click('kitchen-quotation-receive', 'quotation_receive');
  await shareApprove(false);
  await openDisclosure(page, 'quotation-version');
  await page.getByTestId('kitchen-quotation-date').fill('2026-10-19');
  await expect(page.getByTestId('kitchen-quotation-url')).toHaveCount(0);
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
  await expect(page.getByTestId('kitchen-advance-order')).toBeEnabled();
  await expect(page.getByTestId('kitchen-unsaved-notice')).toContainText('Unsaved changes');
  await revisedAmount.fill(savedDraftAmount);
  await expect(page.getByTestId('kitchen-advance-order')).toBeEnabled();
  await click('kitchen-advance-order', 'advance_stage');
  await blocked('kitchen-advance-production');
  await page.getByTestId('kitchen-order-date').fill('2026-10-19');
  await expect(page.getByTestId('kitchen-order-amount')).toHaveValue('1100.01');
  await page.getByTestId('kitchen-order-confirmed-yes').click();
  await click('kitchen-order-confirm', 'order_confirm');
  await openDisclosure(page, 'order-edit');
  await page.getByTestId('kitchen-order-edit-notes').fill('Corrected customer order notes');
  await click('kitchen-order-edit-save', 'order_update');
  await expect(page.getByTestId('kitchen-order-edit-notes')).toHaveValue('Corrected customer order notes');
  await expect(page.getByTestId('kitchen-unsaved-notice')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-disclose-order-document')).toHaveCount(0);
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
  await expect(page.getByTestId('kitchen-site-date')).toHaveValue(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  await page.getByTestId('kitchen-site-date').fill('2026-10-20');
  await page.getByTestId('kitchen-site-actual-no-—-scheduled-only').click();
  const scheduled = await click('kitchen-site-save', 'site_visit');
  expect(scheduled.site_visit_count).toBe(0);
  await expect(page.getByTestId('kitchen-site-date')).toHaveValue(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
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
  expect(waiting.closure_pending_reason).toBeNull();
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
  expect(completedAgain.closure_pending_reason).toBeNull();
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
    command: 'metadata', payload: { target_completion_date: '2026-12-31' },
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
  expect(result.target_completion_date).toBe('2026-12-31');
  await page.reload();
  await expect(notes).toHaveValue('Keep my unsaved draft after the conflict');
  await health.assertHealthy();
});

test('Q13: a lost lead can move forward without changing its saved outcome', async ({ page, context, baseURL }) => {
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
  const rejected = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'move_stage');
  await page.getByTestId('kitchen-convert').click();
  const moved = await rejected;
  expect(moved.ok(), await moved.text()).toBeTruthy();
  expect((await moved.json()).lead.status).toBe('Lost');
  await expect(page.getByTestId('kitchen-previous-stage')).toBeEnabled();
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
  await command('design_response', { version_id: designId, response: 'Approved', approval_date: '2026-10-19' });
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
  await page.getByTestId('kitchen-production-notes').fill('Unsaved earlier-cycle production draft');
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
  await expect(page.getByTestId('kitchen-advance-quotation')).toBeEnabled();
  await page.getByTestId('kitchen-design-new-notes').fill('Revised design for the new approval cycle');
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
  await page.getByTestId('kitchen-design-approval-date').fill('2026-10-19');
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
  await expect(page.getByText('Quotation revision 1', { exact: true })).toBeVisible();
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
  await expect(page.getByText(/^Total design revisions:\s+Historical count unavailable(?: · Newly recorded: 0)?$/)).toBeVisible();
  await expect(page.getByText(/^Actual site visits:\s+Historical count unavailable(?: · Newly recorded: 0)?$/)).toBeVisible();
  await openStageRecord(page, 'lead');
  await expect(page.getByTestId('kitchen-lead-date')).toHaveValue('');
  await openStageRecord(page, 'installation');
  await expect(page.getByText('Start date: —', { exact: true })).toBeVisible();
  await expect(page.getByText('Completion date: —', { exact: true })).toBeVisible();
  const legacyRecord = await context.request.get(`${baseURL}/api/kitchen-projects/${projectId}`, { headers: { 'X-Floor-Id': 'second-floor' } });
  const legacy = await legacyRecord.json();
  expect(legacy.installation.start_date).toBeNull();
  expect(legacy.installation.completion_date).toBeNull();
  await page.screenshot({ path: testInfo.outputPath('legacy-unknown-counts.png') });
  // Kitchen grants preserve authorized history reads without stage assignments.
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
  await (await chooser).setFiles({ name: 'synthetic-private.pdf', mimeType: '', buffer: content });
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
  await page.getByTestId('kitchen-design-requirements').fill('Requirements retained across navigation');
  await page.getByTestId('kitchen-design-new-notes').fill('Unsaved design presentation survives navigation');
  await openProjectPage(page, 'documents');
  await openProjectPage(page, 'history');
  await openProjectPage(page, 'assignments');
  await expect(page.getByTestId('kitchen-target-date')).toBeVisible();
  await expect(page.getByTestId('kitchen-assign-save')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-assignment-sheet')).toBeVisible();
  await openProjectPage(page, 'stage');
  await expect(page.getByTestId('kitchen-design-date')).toHaveValue('2026-10-20');
  await expect(page.getByTestId('kitchen-design-requirements')).toHaveValue('Requirements retained across navigation');
  await expect(page.getByTestId('kitchen-design-new-notes')).toHaveValue('Unsaved design presentation survives navigation');
  await expect(page.getByTestId('kitchen-document-pick')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-history-category')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-exception-reason')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-metadata-save')).toHaveCount(0);
  const presentResponse = page.waitForResponse(response => response.url().endsWith(`/api/kitchen-projects/${project.id}/commands`) && response.request().postDataJSON()?.command === 'design_present');
  await page.getByTestId('kitchen-design-present').click();
  const presented = await presentResponse;
  expect(presented.ok(), await presented.text()).toBeTruthy();
  const stored = await presented.json();
  expect(stored.design_versions.at(-1)).toMatchObject({ presentation_date: '2026-10-20', requirements: 'Requirements retained across navigation', notes: 'Unsaved design presentation survives navigation' });
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

test('Kitchen named stages preview without writes and design details can be corrected before quotation', async ({ page, context }, info) => {
  test.setTimeout(60000);
  const headers = { 'X-Floor-Id': 'second-floor' };
  const created = await context.request.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID,
    idempotency_key: `editable-design-${Date.now()}-${info.project.name}`,
    lead: { site_location: 'Synthetic editable design acceptance' },
  } });
  expect(created.ok(), await created.text()).toBeTruthy();
  let project = await created.json();
  await seedBrowser(page);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await projectReady(page);
  const stageNames = { lead: 'Lead', visit: 'Visit', cad: 'CAD', design: 'Design', quotation: 'Quotation', order: 'Order', production: 'Production', installation: 'Installation', completed: 'Completed' };
  for (const [stage, label] of Object.entries(stageNames)) {
    await expect(page.getByTestId(`kitchen-progress-${stage}`)).toContainText(label);
  }
  const mutations: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/kitchen-projects') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.method()); });
  for (const stage of ['quotation', 'order', 'production', 'installation', 'completed']) {
    await page.getByTestId(`kitchen-progress-${stage}`).click();
    await expect(page).toHaveURL(new RegExp(`/stages/${stage}(?:\\?.*)?$`));
    await expect(page.getByText('Viewing this stage does not move the project or create records.', { exact: true })).toBeVisible();
    const editable = page.getByTestId('kitchen-current-task-region').locator('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])');
    await expect(editable).toHaveCount(0);
  }
  const unchanged = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect(await unchanged.json()).toMatchObject({ stage: 'lead', version: project.version });
  expect(mutations).toEqual([]);
  async function command(name: string, payload: Record<string, unknown> = {}) {
    const response = await context.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
      expected_version: project.version, idempotency_key: `${name}-${Date.now()}-${Math.random()}`, command: name, payload,
    } });
    expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
    project = await response.json();
  }
  if (project.duplicate_review?.status === 'pending') await command('review_duplicate', { decision: 'distinct_project', reason: 'Synthetic separate site' });
  await command('convert');
  await command('save_visit', { status: 'Visited', visit_date: '2026-10-19', display_model: 'Wardrobe' });
  await command('advance_stage', { target_stage: 'cad' });
  await command('save_cad', { received: true, progress: 100, status: 'Completed' });
  await command('advance_stage', { target_stage: 'design' });
  await command('design_present', { presentation_date: '2026-10-19', notes: 'Original presentation' });
  await page.goto(`/kitchen/${project.id}/stages/design`);
  await expect(page.getByTestId('kitchen-disclose-design-edit')).toBeVisible();
  await openDisclosure(page, 'design-edit');
  await page.getByTestId('kitchen-design-edit-requirements').fill('First saved correction');
  await page.getByTestId('kitchen-design-edit-notes').fill('Correct requirements before sharing');
  const firstCorrection = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'design_update');
  await page.getByTestId('kitchen-design-edit-save').click();
  expect((await firstCorrection).ok()).toBeTruthy();
  await page.getByTestId('kitchen-version-share-date').fill('2026-10-20');
  const shared = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'design_share');
  await page.getByTestId('kitchen-version-share').click();
  expect((await shared).ok()).toBeTruthy();
  await expect(page.getByTestId('kitchen-design-edit-shared')).toHaveValue('2026-10-20');
  await page.getByTestId('kitchen-design-edit-date').fill('2026-10-20');
  await page.getByTestId('kitchen-design-edit-requirements').fill('Corrected cabinet layout');
  await page.getByTestId('kitchen-design-edit-budget').fill('Agreed budget discussion');
  await expect(page.getByTestId('kitchen-design-edit-revisions')).toContainText('counted automatically');
  await page.getByRole('button', { name: 'Shared with customer: Yes', exact: true }).click();
  await page.getByTestId('kitchen-design-edit-shared').fill('2026-10-20');
  await page.getByTestId('kitchen-design-edit-response-approved').click();
  await page.getByTestId('kitchen-design-edit-approval-date').fill('2026-10-20');
  await page.getByRole('button', { name: 'Sent to company: Yes', exact: true }).click();
  await page.getByTestId('kitchen-design-edit-handoff').fill('2026-10-20');
  await page.getByTestId('kitchen-design-edit-notes').fill('Correct the recorded presentation details');
  const update = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'design_update');
  await page.getByTestId('kitchen-design-edit-save').click();
  const saved = await update;
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const corrected = await saved.json();
  expect(corrected.design_versions.at(-1)).toMatchObject({ presentation_date: '2026-10-20', shared_date: '2026-10-20', handoff_date: '2026-10-20', response: 'Approved', requirements: 'Corrected cabinet layout', budget_discussion: 'Agreed budget discussion' });
  expect(corrected.design_revision_count).toBe(0);
  await expect(page.getByTestId('kitchen-advance-quotation')).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId('kitchen-disclose-design-edit')).toBeVisible();
  await openDisclosure(page, 'design-edit');
  await expect(page.getByTestId('kitchen-design-edit-requirements')).toHaveValue('Corrected cabinet layout');
  await expect(page.getByTestId('kitchen-design-edit-revisions')).toContainText('0');
  await expect(page.getByTestId('kitchen-advance-quotation')).toBeEnabled();
  await page.getByTestId('kitchen-design-edit-requirements').fill('Retained unsaved correction');
  const current = await (await context.request.get(`/api/kitchen-projects/${project.id}`, { headers: { 'X-Floor-Id': 'second-floor' } })).json();
  const changed = await context.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers: { 'X-Floor-Id': 'second-floor' }, data: {
    expected_version: current.version, idempotency_key: `external-correction-${Date.now()}`, command: 'design_update',
    payload: { version_id: current.design_versions.at(-1).id, presentation_date: '2026-10-20', shared_date: '2026-10-20', handoff_date: '2026-10-20', response: 'Approved', requirements: 'Latest server requirements', reason: 'Another owner correction' },
  } });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Reload saved project', exact: true }).click();
  await expect(page.getByTestId('kitchen-design-edit-reload')).toBeVisible();
  await expect(page.getByTestId('kitchen-design-edit-requirements')).toHaveValue('Retained unsaved correction');
  await expect(page.getByTestId('kitchen-design-edit-save')).toBeDisabled();
  await page.getByTestId('kitchen-design-edit-reload').click();
  await expect(page.getByTestId('kitchen-design-edit-requirements')).toHaveValue('Latest server requirements');
  await expect(page.getByTestId('kitchen-advance-quotation')).toBeEnabled();
});

test('Kitchen lead references create a directory entry and retain complete customer details', async ({ page, context }, info) => {
  await seedBrowser(page);
  await page.goto('/kitchen');
  await page.getByTestId('kitchen-create').click();
  await page.getByTestId('kitchen-customer-name').fill('Reference acceptance customer');
  await page.getByTestId('kitchen-customer-phone').fill(`990${String(Date.now()).slice(-7)}`);
  await page.getByTestId('kitchen-customer-address').fill('Synthetic complete street address');
  await page.getByTestId('kitchen-customer-city').fill('Ahmedabad');
  await page.getByTestId('kitchen-customer-email').fill(`kitchen-${info.project.name}-${Date.now()}@example.com`);
  await page.getByTestId('kitchen-create-lead-site_location').fill('Synthetic site');
  await page.getByRole('button', { name: 'Reference · architect / interior designer', exact: true }).click();
  const name = `Kitchen architect ${info.project.name} ${Date.now()}`;
  await page.getByTestId('customer-referrer-sheet').getByRole('button', { name: 'Architect', exact: true }).click();
  await page.getByLabel('Designer / architect name', { exact: true }).click();
  await page.getByLabel('Designer / architect name', { exact: true }).pressSequentially(name);
  await expect(page.getByRole('button', { name: 'Add and select', exact: true })).toBeEnabled();
  await page.getByTestId('lead-interior-company').fill('Synthetic studio');
  const referenceSaved = page.waitForResponse(response => response.url().endsWith('/api/referrers') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Add and select', exact: true }).click();
  const referenceResponse = await referenceSaved;
  expect(referenceResponse.ok(), await referenceResponse.text()).toBeTruthy();
  const reference = await referenceResponse.json();
  const created = page.waitForResponse(response => response.url().endsWith('/api/kitchen-projects') && response.request().method() === 'POST');
  await page.getByTestId('kitchen-create-submit').click();
  const response = await created;
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = await response.json();
  expect(project.lead).toMatchObject({ referrer_id: reference.id, referrer_name: name, referrer_company: 'Synthetic studio' });
  expect(project.customer).toMatchObject({ address: 'Synthetic complete street address', city: 'Ahmedabad' });
  const details = await context.request.get(`/api/sales-data/referrers/${reference.id}?floor_id=second-floor`);
  expect(details.ok(), await details.text()).toBeTruthy();
  expect((await details.json()).kitchen_projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: project.id, status: 'lead' })]));
});

for (const referenceType of ['architect', 'interior_designer'] as const) {
  test(`Kitchen intake selects an existing ${referenceType} from all references and preserves its directory identity`, async ({ page, context }, info) => {
    const headers = { 'X-Floor-Id': 'second-floor' };
    const suffix = `${info.project.name}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const references = [];
    for (const type of ['architect', 'interior_designer'] as const) {
      const response = await context.request.post('/api/referrers', { headers, data: {
        name: `Existing Kitchen ${type} ${suffix}`, type, company: `Kitchen studio ${type} ${suffix}`,
      } });
      expect(response.ok(), await response.text()).toBeTruthy();
      references.push(await response.json());
    }
    const reference = references.find(row => row.type === referenceType)!;
    const health = captureRuntimeHealth(page);
    await seedBrowser(page);
    await page.goto('/kitchen');
    await page.getByTestId('kitchen-create').click();
    const customerName = `Existing reference customer ${suffix}`;
    const phone = `9${String(Date.now() + Math.floor(Math.random() * 1_000_000)).slice(-9)}`;
    await page.getByTestId('kitchen-customer-name').fill(customerName);
    await page.getByTestId('kitchen-customer-phone').fill(phone);
    await page.getByTestId('kitchen-customer-address').fill('Synthetic reference selection address');
    await page.getByTestId('kitchen-customer-city').fill('Ahmedabad');
    await page.getByTestId('kitchen-create-lead-site_location').fill(`Existing ${referenceType} selection site`);
    const directoryRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/referrers' && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Reference · architect / interior designer', exact: true }).click();
    const loaded = await directoryRead;
    expect(loaded.ok(), await loaded.text()).toBeTruthy();
    expect(new URL(loaded.url()).searchParams.has('type'), 'The directory loads both reference kinds').toBe(false);
    const sheet = page.getByTestId('customer-referrer-sheet');
    await expect(sheet.getByRole('button', { name: 'All references', exact: true })).toBeVisible();
    const search = sheet.getByLabel('Search references', { exact: true });
    // Company search narrows a populated directory without selecting a category.
    await search.fill(reference.company);
    await expect(sheet.getByRole('button', { name: reference.name, exact: true })).toBeVisible();
    const code = `${referenceType === 'architect' ? 'ARC' : 'INT'}-${reference.id.toUpperCase()}`;
    await search.fill(code);
    await expect(sheet.getByRole('button', { name: reference.name, exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: reference.name, exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: 'Reference · architect / interior designer', exact: true })).toContainText(reference.name);
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/kitchen-projects' && response.request().method() === 'POST');
    await page.getByTestId('kitchen-create-submit').click();
    const response = await created;
    expect(response.ok(), await response.text()).toBeTruthy();
    const project = await response.json();
    const identity = { referrer_id: reference.id, referrer_type: referenceType, referrer_name: reference.name, referrer_company: reference.company };
    expect(project).toMatchObject(identity);
    expect(project.lead).toMatchObject(identity);
    expect(project.customer).toMatchObject({ name: customerName, phone, address: 'Synthetic reference selection address', city: 'Ahmedabad' });
    const persisted = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
    expect(persisted.ok(), await persisted.text()).toBeTruthy();
    expect(await persisted.json()).toMatchObject({ ...identity, lead: identity, customer_id: project.customer.id });
    await health.assertHealthy();
  });
}

test('Kitchen moves forward and backward through all nine stages without task prerequisites', async ({ page, context }) => {
  await seedBrowser(page);
  const headers = { 'X-Floor-Id': 'second-floor' };
  const response = await context.request.post('/api/kitchen-projects', { headers, data: { customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: `manual-navigation-${Date.now()}-${Math.random()}`, lead: { site_location: 'Manual movement synthetic site' } } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = await response.json();
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await projectReady(page);
  await page.getByTestId('kitchen-lead-site_location').fill('Unsaved draft remains available');
  const stages = ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed'];
  const health = captureRuntimeHealth(page);
  for (let index = 1; index < stages.length; index++) {
    const target = stages[index];
    const button = page.getByTestId(index === 1 ? 'kitchen-convert' : `kitchen-advance-${target}`);
    await expect(button).toBeEnabled();
    const saved = page.waitForResponse(value => value.url().endsWith('/commands') && value.request().postDataJSON()?.command === 'move_stage');
    await button.click();
    const moved = await saved;
    expect(moved.ok(), await moved.text()).toBeTruthy();
    const body = await moved.json();
    expect(body.stage).toBe(target);
    expect(body.orders).toEqual([]);
    expect(body.approvals).toEqual([]);
    await expect(page).toHaveURL(new RegExp(`/stages/${target}(?:\\?.*)?$`));
    await projectReady(page);
  }
  for (let index = stages.length - 2; index >= 0; index--) {
    await expect(page.getByTestId('kitchen-previous-stage')).toBeEnabled();
    const saved = page.waitForResponse(value => value.url().endsWith('/commands') && value.request().postDataJSON()?.command === 'move_stage');
    await page.getByTestId('kitchen-previous-stage').click();
    const moved = await saved;
    expect(moved.ok(), await moved.text()).toBeTruthy();
    expect((await moved.json()).stage).toBe(stages[index]);
    await expect(page).toHaveURL(new RegExp(`/stages/${stages[index]}(?:\\?.*)?$`));
    await projectReady(page);
  }
  await expect(page.getByTestId('kitchen-lead-site_location')).toHaveValue('Unsaved draft remains available');
  await expect(page.getByTestId('kitchen-previous-stage')).toHaveCount(0);
  const final = await (await context.request.get(`/api/kitchen-projects/${project.id}`, { headers })).json();
  expect(final.lead.site_location).toBe('Manual movement synthetic site');
  expect(final.installation?.completion_date ?? null).toBeNull();
  expect(final.activity.filter((event: any) => event.type === 'move_stage')).toHaveLength(16);
  await health.assertHealthy();
});


test('Kitchen owner selects PDF assignments without adding the excluded Visit fields', async ({ page, context, baseURL }) => {
  const health = captureRuntimeHealth(page);
  await seedBrowser(page);
  await page.goto('/kitchen/stages/lead');
  await page.getByTestId('kitchen-create').click();
  await page.getByTestId('kitchen-existing-customer').click();
  await page.getByTestId('kitchen-customer').fill('Kitchen acceptance customer');
  await page.getByTestId(`kitchen-customer-${process.env.KITCHEN_E2E_CUSTOMER_ID}`).click();
  await page.getByTestId('kitchen-create-lead-site_location').fill('Owner-selected assignment test site');
  const worker = process.env.KITCHEN_E2E_WORKER_ID!;
  await page.getByTestId('kitchen-create-assignee').click();
  await page.getByTestId(`kitchen-create-assignee-${worker}`).click();
  const creation = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/kitchen-projects');
  await page.getByTestId('kitchen-create-submit').click();
  const savedResponse = await creation;
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
  const saved = await savedResponse.json();
  expect(saved.assignments.lead).toBe(worker);
  await expect(page.getByTestId('kitchen-assignee')).toContainText('Kitchen acceptance worker');
  const moved = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'move_stage');
  await page.getByTestId('kitchen-convert').click();
  expect((await moved).ok()).toBe(true);
  await expect(page.getByTestId('kitchen-visit-save')).toBeVisible();
  await expect(page.getByTestId('kitchen-assignee')).toContainText('Unassigned');
  await expect(page.getByTestId('kitchen-visit-requirements')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-visit-budget')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-visit-next-action')).toHaveCount(0);
  await page.getByTestId('kitchen-assignee').click();
  const assigned = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'assign');
  await page.getByTestId(`kitchen-assignee-${worker}`).click();
  expect((await assigned).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('kitchen-assignee')).toContainText('Kitchen acceptance worker');
  const fetched = await context.request.get(`${baseURL}/api/kitchen-projects/${saved.id}`, { headers: { 'X-Floor-Id': 'second-floor' } });
  expect((await fetched.json()).assignments).toMatchObject({ lead: worker, visit: worker });
  await health.assertHealthy();
});


test('Completed export retains the selected PDF employee filter', async ({ page }) => {
  await seedBrowser(page);
  await page.goto('/kitchen/stages/completed?assignee=unassigned');
  await expect(page.getByTestId('kitchen-completed-export')).toBeVisible();
  const exported = page.waitForRequest(request => new URL(request.url()).pathname === '/api/kitchen-projects/export');
  await page.getByTestId('kitchen-completed-export').click();
  expect(new URL((await exported).url()).searchParams.get('assignee')).toBe('unassigned');
});
