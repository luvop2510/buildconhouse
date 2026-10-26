import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';

const headers = { 'X-Floor-Id': 'second-floor' };
async function command(api: APIRequestContext, project: any, name: string, payload: object) {
  const response = await api.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: {
    expected_version: project.version, idempotency_key: randomUUID(), command: name, payload,
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function clickCommand(page: Page, id: string, name: string, expectedPayload?: Record<string, unknown>) {
  const response = page.waitForResponse(row => row.url().endsWith('/commands') && row.request().postDataJSON()?.command === name);
  await page.getByTestId(id).click();
  const saved = await response;
  expect(saved.ok(), await saved.text()).toBe(true);
  if (expectedPayload) expect(saved.request().postDataJSON().payload).toMatchObject(expectedPayload);
  return saved.json();
}
async function select(page: Page, id: string, label: string) {
  await page.getByTestId(id).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}
async function seed(api: APIRequestContext) {
  const response = await api.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(), lead: { site_location: 'Version history acceptance' },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  let project = await response.json();
  for (const stage of ['visit', 'cad', 'design']) project = await command(api, project, 'move_stage', { target_stage: stage });
  for (let number = 1; number <= 2; number++) {
    if (number > 1) project = await command(api, project, 'design_revision', { version_id: project.design_versions.at(-1).id, reason: 'Customer requests another layout' });
    project = await command(api, project, 'design_present', { presentation_date: '2026-10-20', requirements: `Requirements for v${number}`, budget_discussion: `Budget for v${number}`, notes: `Private design v${number}` });
    const id = project.design_versions.at(-1).id;
    project = await command(api, project, 'design_share', { version_id: id, date: '2026-10-20' });
    project = await command(api, project, 'design_response', { version_id: id, response: 'Approved', approval_date: '2026-10-21', notes: `Internal approval v${number}` });
    project = await command(api, project, 'design_handoff', { version_id: id, date: '2026-10-22' });
  }
  return project;
}
async function open(page: Page, project: any, stage: string) {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
  await page.goto(`/kitchen/${project.id}/stages/${stage}`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
}

test('Design and quotation selectors preserve version history, blank price and older order basis downstream', async ({ page, context }, info) => {
  let project = await seed(context.request);
  const health = captureRuntimeHealth(page);
  await open(page, project, 'design');
  const writes: string[] = [];
  page.on('request', row => { if (row.method() === 'POST' && row.url().endsWith('/commands')) writes.push(row.postDataJSON().command); });
  await select(page, 'kitchen-design-version', 'Design v1 · Approved');
  await expect(page.getByTestId('kitchen-design-edit-notes')).toHaveValue('Private design v1');
  await expect(page.getByText('Presentation date', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Share with the customer', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('kitchen-design-edit-requirements')).toHaveValue('Requirements for v1');
  await expect(page.getByTestId('kitchen-design-edit-notes')).toHaveAccessibleName('Internal notes');
  await expect(page.getByTestId('kitchen-design-edit-handoff')).toHaveValue('2026-10-22');
  await page.getByTestId('kitchen-design-edit-handoff').fill('2026-10-20');
  await expect(page.getByTestId('kitchen-design-edit-save')).toBeDisabled();
  await page.getByTestId('kitchen-design-edit-handoff').fill('2026-10-23');
  await expect(page.getByTestId('kitchen-design-edit-save')).toBeEnabled();
  await page.getByTestId('kitchen-design-edit-notes').fill('Internal corrected v1');
  project = await clickCommand(page, 'kitchen-design-edit-save', 'design_update');
  expect(project.design_versions[0].notes).toBe('Internal corrected v1');
  expect(project.design_versions[1].notes).toBe('Private design v2');
  await select(page, 'kitchen-design-version', 'Design v2 · Approved');
  await expect(page.getByTestId('kitchen-design-edit-requirements')).toHaveValue('Requirements for v2');
  expect(writes).toEqual(['design_update']);
  await clickCommand(page, 'kitchen-advance-quotation', 'move_stage');
  await select(page, 'kitchen-quotation-design-version', 'Design v1 · Approved');
  await expect(page.getByTestId('kitchen-quotation-amount')).toHaveValue('');
  await expect(page.getByText('Quotation document', { exact: true })).toHaveCount(0);
  await page.getByTestId('kitchen-quotation-notes').fill('Private quotation r1');
  project = await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive', { design_version_id: project.design_versions[0].id });
  const quotation1 = project.quotation_versions.at(-1);
  expect(quotation1).toMatchObject({ amount: null, design_version_id: project.design_versions[0].id });
  expect(quotation1.attachment_id).toBeNull();
  expect(quotation1.received_status).toBe('Not recorded');
  expect(quotation1.sent_status).toBe('Not recorded');
  await expect(page.getByTestId('kitchen-quotation-received-not-recorded')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('kitchen-quotation-sent-yes').click();
  await page.getByTestId('kitchen-quotation-shared-date').fill('2026-10-26');
  await page.getByTestId('kitchen-version-response-approved').click();
  project = await clickCommand(page, 'kitchen-quotation-edit-save', 'quotation_update', { version_id: quotation1.id });
  await page.getByTestId('kitchen-quotation-new-version').click();
  await expect(page.getByTestId('kitchen-quotation-design-version')).toContainText('Design v1');
  await page.getByTestId('kitchen-quotation-amount').fill('2000');
  project = await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive', { design_version_id: project.design_versions[0].id });
  const quotation2 = project.quotation_versions.at(-1);
  expect(quotation2).toMatchObject({ number: 2, design_version_id: project.design_versions[0].id });
  await page.getByTestId('kitchen-quotation-new-version').click();
  await select(page, 'kitchen-quotation-design-version', 'Design v2 · Approved');
  await page.getByTestId('kitchen-quotation-amount').fill('2100');
  project = await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive', { design_version_id: project.design_versions[1].id });
  expect(project.quotation_versions.at(-1)).toMatchObject({ number: 3, design_version_id: project.design_versions[1].id });
  await select(page, 'kitchen-quotation-revision', 'Quotation 2 · Pending');
  await expect(page.getByTestId('kitchen-quotation-amount')).toHaveValue('2000.00');
  await expect(page.getByTestId('kitchen-quotation-design-version')).toContainText('Design v1');
  const beforeHistory = writes.length;
  await select(page, 'kitchen-quotation-revision', 'Quotation 1 · Approved');
  await expect(page.getByTestId('kitchen-quotation-notes')).toHaveValue('Private quotation r1');
  await expect(page.getByTestId('kitchen-quotation-design-version')).toContainText('Design v1');
  expect(writes).toHaveLength(beforeHistory);
  await page.screenshot({ path: info.outputPath('quotation-version-history.png'), fullPage: true });
  await clickCommand(page, 'kitchen-advance-order', 'move_stage');
  await select(page, 'kitchen-order-quotation-revision', 'Quotation 1 · Design v1 · Approved');
  await page.getByTestId('kitchen-order-confirmed-yes').click();
  await clickCommand(page, 'kitchen-order-confirmation-save', 'order_confirmation');
  await expect(page.getByText('Customer order confirmation: Yes', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Customer order confirmation: Yes', { exact: true })).toBeVisible();
  await select(page, 'kitchen-order-quotation-revision', 'Quotation 1 · Design v1 · Approved');
  await page.getByTestId('kitchen-order-date').fill('2026-10-26');
  await page.getByTestId('kitchen-order-amount').fill('1500');
  await page.getByTestId('kitchen-order-notes').fill('Internal order note');
  project = await clickCommand(page, 'kitchen-order-confirm', 'order_confirm', { quotation_version_id: quotation1.id });
  expect(project.orders.at(-1)).toMatchObject({ confirmed: true, quotation_version_id: quotation1.id, original_amount: null, final_amount: '1500.00' });
  await page.reload();
  await expect(page.getByText('Customer order confirmation: Yes', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-order-confirmed-no').click();
  await clickCommand(page, 'kitchen-order-confirmation-save', 'order_confirmation');
  await page.reload();
  await expect(page.getByText('Customer order confirmation: No', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-order-confirmed-yes').click();
  await clickCommand(page, 'kitchen-order-confirmation-save', 'order_confirmation');
  await page.getByTestId('kitchen-order-status-on-hold').click();
  await page.getByTestId('kitchen-order-status-notes').fill('Internal scheduling hold');
  await clickCommand(page, 'kitchen-order-status-save', 'order_status');
  await expect(page.getByText('Order status: On Hold', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-order-status-confirmed').click();
  await page.getByTestId('kitchen-order-status-notes').fill('Internal scheduling resumed');
  await clickCommand(page, 'kitchen-order-status-save', 'order_status');
  await expect(page.getByText('Order status: Confirmed', { exact: true })).toBeVisible();
  const beforeView = writes.length;
  await select(page, 'kitchen-order-quotation-revision', 'Quotation 3 · Design v2 · Pending');
  await expect(page.getByText('Order quotation: Quotation 1 · Design v1', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(beforeView);
  await clickCommand(page, 'kitchen-advance-production', 'move_stage');
  await expect(page.getByText('Quotation 1 · Design v1', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-production-status-in-production').click();
  await expect(page.getByTestId('kitchen-production-start')).toHaveValue('');
  await page.getByTestId('kitchen-production-start').fill('2026-10-26');
  project = await clickCommand(page, 'kitchen-production-save', 'production_update');
  await page.reload();
  await expect(page.getByText('Quotation 1 · Design v1', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('production-saved-version.png'), fullPage: true });
  await clickCommand(page, 'kitchen-advance-installation', 'move_stage');
  await expect(page.getByText('Quotation 1 · Design v1', { exact: true })).toBeVisible();
  const after = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  const saved = await after.json();
  expect(saved.orders.at(-1).quotation_version_id).toBe(quotation1.id);
  expect(saved.design_versions).toHaveLength(2);
  expect(saved.quotation_versions).toHaveLength(3);
  await health.assertHealthy();
});


test('Rejected price for Design v3 returns to Design v4 without replacing earlier quotations', async ({ page, context }, info) => {
  let project = await seed(context.request);
  project = await command(context.request, project, 'design_revision', { version_id: project.design_versions.at(-1).id, reason: 'Customer requested third layout' });
  project = await command(context.request, project, 'design_present', { presentation_date: '2026-10-24', notes: 'Internal v3 details' });
  const v3 = project.design_versions.at(-1).id;
  project = await command(context.request, project, 'design_share', { version_id: v3, date: '2026-10-24' });
  project = await command(context.request, project, 'design_response', { version_id: v3, response: 'Approved', approval_date: '2026-10-24' });
  project = await command(context.request, project, 'design_handoff', { version_id: v3, date: '2026-10-25' });
  project = await command(context.request, project, 'move_stage', { target_stage: 'quotation' });
  project = await command(context.request, project, 'quotation_receive', { design_version_id: v3, received_date: '2026-10-26', amount: '5000', notes: 'Internal rejected-price quote' });
  const r1 = project.quotation_versions.at(-1).id;
  project = await command(context.request, project, 'quotation_share', { version_id: r1, date: '2026-10-26' });
  const health = captureRuntimeHealth(page);
  await open(page, project, 'quotation');
  await page.getByTestId('kitchen-version-response-changes-required').click();
  project = await clickCommand(page, 'kitchen-quotation-edit-save', 'quotation_update');
  expect(project.quotation_versions[0].response).toBe('Changes Required');
  await clickCommand(page, 'kitchen-previous-stage', 'move_stage');
  await page.getByTestId('kitchen-design-new-version').click();
  await page.getByTestId('kitchen-design-edit-notes').fill('Internal v4 details');
  await page.getByTestId('kitchen-design-edit-shared').fill('2026-10-26');
  await page.getByTestId('kitchen-design-edit-response-approved').click();
  await page.getByTestId('kitchen-design-edit-approval-date').fill('2026-10-26');
  await page.getByTestId('kitchen-design-sent-yes').click();
  await page.getByTestId('kitchen-design-edit-handoff').fill('2026-10-26');
  project = await clickCommand(page, 'kitchen-design-present', 'design_present');
  expect(project.design_versions.at(-1).number).toBe(4);
  expect(project.design_versions.at(-1).presentation_date).toBeNull();
  await expect(page.getByTestId('kitchen-design-version')).toContainText('Design v4');
  await clickCommand(page, 'kitchen-advance-quotation', 'move_stage');
  await page.getByTestId('kitchen-quotation-new-version').click();
  await select(page, 'kitchen-quotation-design-version', 'Design v4 · Approved');
  project = await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive', { design_version_id: project.design_versions.at(-1).id });
  expect(project.quotation_versions.at(-1).design_version_id).toBe(project.design_versions.at(-1).id);
  expect(project.quotation_versions[0]).toMatchObject({ id: r1, design_version_id: v3, response: 'Changes Required', amount: '5000.00' });
  await select(page, 'kitchen-quotation-revision', 'Quotation 1 · Changes Required');
  await expect(page.getByTestId('kitchen-quotation-design-version')).toContainText('Design v3');
  await expect(page.getByTestId('kitchen-quotation-notes')).toHaveValue('Internal rejected-price quote');
  await page.screenshot({ path: info.outputPath('rejected-price-history.png'), fullPage: true });
  await health.assertHealthy();
});


test('New Design dates default to today while saved dates remain editable and historical blanks stay unknown', async ({ page, context }) => {
  let project = await seed(context.request);
  const original = project.design_versions[0];
  const health = captureRuntimeHealth(page);
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  await open(page, project, 'design');
  await page.getByTestId('kitchen-design-new-version').click();
  await expect(page.getByTestId('kitchen-design-edit-shared')).toHaveValue(today);
  await expect(page.getByTestId('kitchen-design-edit-approval-date')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-design-edit-handoff')).toHaveCount(0);
  await page.getByTestId('kitchen-design-edit-shared').fill(yesterday);
  await page.getByTestId('kitchen-design-edit-response-approved').click();
  await expect(page.getByTestId('kitchen-design-edit-approval-date')).toHaveValue(today);
  await page.getByTestId('kitchen-design-edit-approval-date').fill(yesterday);
  await page.getByTestId('kitchen-design-sent-yes').click();
  await expect(page.getByTestId('kitchen-design-edit-handoff')).toHaveValue(today);
  project = await clickCommand(page, 'kitchen-design-present', 'design_present', { shared_date: yesterday, approval_date: yesterday, handoff_status: 'Yes', handoff_date: today });
  const createdId = project.design_versions.at(-1).id;
  await page.reload();
  await expect(page.getByTestId('kitchen-design-edit-handoff')).toHaveValue(today);
  await page.getByTestId('kitchen-design-edit-handoff').fill(yesterday);
  project = await clickCommand(page, 'kitchen-design-edit-save', 'design_update', { version_id: createdId, handoff_date: yesterday });
  expect(project.design_versions[0]).toEqual(original);
  expect(project.design_versions.at(-1)).toMatchObject({ id: createdId, handoff_date: yesterday });
  project = await command(context.request, project, 'design_present', { notes: 'Known missing historical dates' });
  await page.reload();
  await expect(page.getByTestId('kitchen-design-edit-shared')).toHaveValue('');
  await page.getByTestId('kitchen-design-edit-shared').focus();
  await expect(page.getByTestId('kitchen-design-edit-shared')).toHaveValue(today);
  await page.getByTestId('kitchen-design-edit-shared').fill('');
  await expect(page.getByTestId('kitchen-design-sent-not-recorded')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('kitchen-design-edit-handoff')).toHaveCount(0);
  await page.getByTestId('kitchen-design-edit-response-approved').click();
  await expect(page.getByTestId('kitchen-design-edit-approval-date')).toHaveValue(today);
  await health.assertHealthy();
});
