import { projectControl } from './kitchen-controls';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { captureRuntimeHealth } from './runtime-health';
import { kitchenFixtureCommand as command, kitchenIndiaToday, uploadKitchenFixturePdf, uploadKitchenPdfInForm, kitchenPdfBytes } from './kitchen-pdf-fixtures';
const headers = { 'X-Floor-Id': 'second-floor' };
async function clickCommand(page: Page, id: string, name: string, expectedPayload?: Record<string, unknown>) {
  const pending = page.waitForResponse(row => row.url().endsWith('/commands') && row.request().postDataJSON()?.command === name);
  await (await projectControl(page, id)).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  if (expectedPayload) expect(response.request().postDataJSON().payload).toMatchObject(expectedPayload);
  return response.json();
}
async function select(page: Page, id: string, label: string) {
  await page.getByTestId(id).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}
async function seed(api: APIRequestContext, count = 2) {
  const created = await api.post('/api/kitchen-projects', { headers, data: { customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(), lead: { site_location: 'PDF version history acceptance' } } });
  expect(created.ok(), await created.text()).toBe(true);
  let project = await created.json();
  for (const target_stage of ['visit','cad','design']) project = await command(api, project, 'move_stage', { target_stage });
  for (let number = 1; number <= count; number++) {
    if (number > 1) project = await command(api, project, 'design_revision', { version_id: project.design_versions.at(-1).id, reason: 'Customer requests revised layout' });
    const uploaded = await uploadKitchenFixturePdf(api, project, `design-v${number}.pdf`);
    project = await command(api, uploaded.project, 'design_present', { attachment_ids: [uploaded.attachment.id], final_attachment_id: uploaded.attachment.id, shared_date: kitchenIndiaToday(), approval_date: kitchenIndiaToday(), response: 'Approved', handoff_status: 'Yes' });
  }
  project = await command(api, project, 'design_update', { version_id: project.design_versions[0].id, response: 'Approved', finalize: true, reason: 'Customer chose this design' });
  return project;
}
async function open(page: Page, project: any, stage: string) {
  await page.addInitScript(() => { localStorage.setItem('forge.jwt.kind', JSON.stringify('staff')); localStorage.setItem('forge.active-floor', JSON.stringify('second-floor')); });
  await page.goto(`/kitchen/${project.id}/stages/${stage}`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
}
async function quoteInForm(page: Page, type: string, filename: string) {
  const uploaded = await uploadKitchenPdfInForm(page, `kitchen-quotation-${type}-pdf`, filename);
  await page.getByTestId(`kitchen-quotation-${type}-pdf-${uploaded.attachment.id}-final`).click();
  return uploaded;
}

test('Design and quotation selectors preserve PDF history, blank price and older order basis downstream', async ({ page, context }, info) => {
  let project = await seed(context.request);
  const health = captureRuntimeHealth(page);
  await open(page, project, 'design');
  const writes: string[] = [];
  page.on('request', row => { if (row.method() === 'POST' && row.url().endsWith('/commands')) writes.push(row.postDataJSON().command); });
  await select(page, 'kitchen-design-version', 'Design 1 · Approved · Finalize PDF');
  await expect(page.getByTestId(`kitchen-design-pdf-${project.design_versions[0].final_attachment_id}`)).toContainText('design-v1.pdf');
  await expect(page.getByTestId('kitchen-design-edit-requirements')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-design-edit-budget')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-design-edit-notes')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-design-sent-not-recorded')).toHaveCount(0);
  await select(page, 'kitchen-design-version', 'Design 2 · Approved');
  await expect(page.getByTestId(`kitchen-design-pdf-${project.design_versions[1].final_attachment_id}`)).toContainText('design-v2.pdf');
  expect(writes).toEqual([]);
  await clickCommand(page, 'kitchen-advance-quotation', 'move_stage');
  await select(page, 'kitchen-quotation-design-version', 'Design 1 · Approved');
  await expect(page.getByTestId('kitchen-quotation-final-design')).toContainText('design-v1.pdf');
  await expect(page.getByTestId('kitchen-quotation-amount')).toHaveCount(0);
  await quoteInForm(page, 'GI', 'quotation-r1-GI.pdf');
  project = await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive', { design_version_id: project.design_versions[0].id });
  const quotation1 = project.quotation_versions.at(-1);
  expect(quotation1).toMatchObject({ amount: null, kitchen_type: 'GI', upload_date: kitchenIndiaToday(), received_date: kitchenIndiaToday() });
  await page.getByTestId('kitchen-quotation-sent-yes').click();
  await page.getByTestId('kitchen-version-response-approved').click();
  project = await clickCommand(page, 'kitchen-quotation-edit-save', 'quotation_update', { version_id: quotation1.id });
  await page.getByTestId('kitchen-quotation-new-version').click();
  await quoteInForm(page, 'SS', 'quotation-r2-SS.pdf');
  project = await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive');
  expect(project.quotation_versions.at(-1)).toMatchObject({ number: 2, design_version_id: project.design_versions[0].id, kitchen_type: 'SS' });
  await clickCommand(page, 'kitchen-previous-stage', 'move_stage');
  await select(page, 'kitchen-design-version', 'Design 2 · Approved');
  await page.getByTestId('kitchen-design-finalize').click();
  project = await clickCommand(page, 'kitchen-design-edit-save', 'design_update');
  await clickCommand(page, 'kitchen-advance-quotation', 'move_stage');
  await page.getByTestId('kitchen-quotation-new-version').click();
  await select(page, 'kitchen-quotation-design-version', 'Design 2 · Approved');
  await quoteInForm(page, 'Mix', 'quotation-r3-Mix.pdf');
  project = await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive');
  expect(project.quotation_versions.at(-1)).toMatchObject({ number: 3, design_version_id: project.design_versions[1].id, kitchen_type: 'Mix' });
  await page.getByTestId('kitchen-quotation-sent-yes').click();
  await page.getByTestId('kitchen-version-response-approved').click();
  project = await clickCommand(page, 'kitchen-quotation-edit-save', 'quotation_update');
  await select(page, 'kitchen-quotation-revision', 'Quotation 2 · Pending');
  await expect(page.getByTestId('kitchen-quotation-final-selection')).toContainText('SS');
  const beforeHistory = writes.length;
  await select(page, 'kitchen-quotation-revision', 'Quotation 1 · Approved');
  await expect(page.getByTestId('kitchen-quotation-final-selection')).toContainText('GI');
  await expect(page.getByTestId('kitchen-quotation-design-version')).toContainText('Design 1');
  expect(writes).toHaveLength(beforeHistory);
  await clickCommand(page, 'kitchen-advance-order', 'move_stage');
  await select(page, 'kitchen-order-quotation-revision', 'Quotation 1 · Design v1 · Approved');
  await page.getByTestId('kitchen-order-confirmed-yes').click();
  await clickCommand(page, 'kitchen-order-confirmation-save', 'order_confirmation');
  await expect(page.getByTestId('kitchen-order-confirmed-yes')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByTestId('kitchen-order-confirmed-yes')).toHaveAttribute('aria-pressed', 'true');
  await select(page, 'kitchen-order-quotation-revision', 'Quotation 1 · Design v1 · Approved');
  await page.getByTestId('kitchen-order-date').fill(kitchenIndiaToday());
  await page.getByTestId('kitchen-order-amount').fill('1500');
  await page.getByTestId('kitchen-order-notes').fill('Internal order note');
  project = await clickCommand(page, 'kitchen-order-confirm', 'order_confirm', { quotation_version_id: quotation1.id });
  expect(project.orders.at(-1)).toMatchObject({ confirmed: true, quotation_version_id: quotation1.id, original_amount: null, final_amount: '1500.00' });
  await page.reload();
  await expect(page.getByTestId('kitchen-disclose-order-confirmation')).toContainText('Customer confirmation: Yes');
  await page.getByTestId('kitchen-disclose-order-confirmation').click();
  await page.getByTestId('kitchen-order-confirmed-no').click();
  await clickCommand(page, 'kitchen-order-confirmation-save', 'order_confirmation');
  await page.reload();
  await expect(page.getByTestId('kitchen-disclose-order-confirmation')).toContainText('Customer confirmation: No');
  await page.getByTestId('kitchen-disclose-order-confirmation').click();
  await page.getByTestId('kitchen-order-confirmed-yes').click();
  await clickCommand(page, 'kitchen-order-confirmation-save', 'order_confirmation');
  await page.getByTestId('kitchen-disclose-order-status').click();
  await page.getByTestId('kitchen-order-status-on-hold').click();
  await page.getByTestId('kitchen-order-status-notes').fill('Internal scheduling hold');
  await clickCommand(page, 'kitchen-order-status-save', 'order_status');
  await expect(page.getByTestId('kitchen-disclose-order-status')).toContainText('Status: On Hold');
  await page.getByTestId('kitchen-order-status-confirmed').click();
  await page.getByTestId('kitchen-order-status-notes').fill('Internal scheduling resumed');
  await clickCommand(page, 'kitchen-order-status-save', 'order_status');
  await expect(page.getByTestId('kitchen-disclose-order-status')).toContainText('Status: Confirmed');
  const beforeView = writes.length;
  await expect(page.getByTestId('kitchen-disclose-order-details')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-order-quotation-revision')).toHaveCount(0);
  await expect(page.getByText('Order quotation: Quotation 1 · Design v1', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(beforeView);
  await clickCommand(page, 'kitchen-advance-production', 'move_stage');
  await expect(page.getByText('Quotation 1 · Design v1', { exact: true })).toBeVisible();
  await page.getByTestId('kitchen-production-status-in-production').click();
  await expect(page.getByTestId('kitchen-production-start')).toHaveValue(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  await page.getByTestId('kitchen-production-start').fill(kitchenIndiaToday());
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

test('Quotations accept all three kitchen types while exactly one selected PDF becomes final', async ({ page, context }, info) => {
  await page.addInitScript(() => {
    const original = URL.createObjectURL.bind(URL);
    (window as any).__kitchenPreviewBlobs = new Map<string, Blob>();
    URL.createObjectURL = blob => { const url = original(blob); (window as any).__kitchenPreviewBlobs.set(url, blob); return url; };
  });
  let project = await seed(context.request, 1);
  project = await command(context.request, project, 'move_stage', { target_stage: 'quotation' });
  await open(page, project, 'quotation');
  const health = captureRuntimeHealth(page);
  await expect(page.getByTestId('kitchen-quotation-receive')).toBeDisabled();
  const gi = await uploadKitchenPdfInForm(page, 'kitchen-quotation-GI-pdf', 'budget-GI.pdf');
  const ss = await uploadKitchenPdfInForm(page, 'kitchen-quotation-SS-pdf', 'budget-SS.pdf');
  const mix = await uploadKitchenPdfInForm(page, 'kitchen-quotation-Mix-pdf', 'budget-Mix.pdf');
  await expect(page.getByTestId('kitchen-quotation-receive')).toBeDisabled();
  await page.getByTestId(`kitchen-quotation-SS-pdf-${ss.attachment.id}-final`).click();
  await page.getByTestId(`kitchen-quotation-GI-pdf-${gi.attachment.id}-final`).click();
  await expect(page.getByTestId(`kitchen-quotation-SS-pdf-${ss.attachment.id}-final`)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId(`kitchen-quotation-GI-pdf-${gi.attachment.id}-final`)).toHaveAttribute('aria-pressed', 'true');
  project = await clickCommand(page, 'kitchen-quotation-receive', 'quotation_receive');
  expect(project.quotation_versions.at(-1)).toMatchObject({ kitchen_type: 'GI', final_attachment_id: gi.attachment.id, received_date: kitchenIndiaToday() });
  expect(project.quotation_versions.at(-1).pdf_options).toHaveLength(3);
  await page.reload();
  await expect(page.getByTestId('kitchen-quotation-final-selection')).toContainText('GI');
  await page.screenshot({ path: info.outputPath('final-quotation-three-kitchen-types.png'), fullPage: true });
  const download = page.waitForEvent('download');
  await page.getByTestId(`kitchen-quotation-Mix-pdf-${mix.attachment.id}-download`).click();
  if (info.project.name !== 'kitchen-desktop') {
    await expect(page.getByTestId('mobile-file-save')).toBeVisible();
    await page.getByTestId('mobile-file-download').click();
  }
  const downloaded = await download;
  expect(downloaded.suggestedFilename()).toBe('budget-Mix.pdf');
  const stream = await downloaded.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(kitchenPdfBytes('budget-Mix.pdf'));
  const popup = page.waitForEvent('popup');
  const navigation = context.waitForEvent('request', { predicate: request => request.isNavigationRequest() && request.url().startsWith('blob:') });
  await page.getByTestId(`kitchen-quotation-GI-pdf-${gi.attachment.id}-open`).click();
  const preview = await popup;
  const opened = await navigation;
  // Headless Chromium can download PDF navigation instead of loading its viewer.
  const openedBytes = await page.evaluate(async url => Array.from(new Uint8Array(await (window as any).__kitchenPreviewBlobs.get(url).arrayBuffer())), opened.url());
  expect(Buffer.from(openedBytes)).toEqual(kitchenPdfBytes('budget-GI.pdf'));
  await preview.close();
  await health.assertHealthy();
});

test('Each uploaded PDF creates one numbered Design without a four-design cap, and an older chosen design drives quotation', async ({ page, context }, info) => {
  let project = await seed(context.request, 1);
  await open(page, project, 'design');
  const health = captureRuntimeHealth(page);
  await expect(page.getByTestId('kitchen-design-new-version')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-design-present')).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('kitchen-design-pdf-pick').click();
  await (await chooser).setFiles({ name: 'oversize-design.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10_000_001)]) });
  await page.getByTestId('kitchen-design-pdf-upload').click();
  await expect(page.getByText('Choose a nonempty PDF up to 10 MB (10,000,000 bytes). The server validates its content.', { exact: true })).toBeVisible();
  expect((await (await context.request.get(`/api/kitchen-projects/${project.id}`, { headers })).json()).attachments).toHaveLength(project.attachments.length);
  const first = project.design_versions[0];
  for (let number = 2; number <= 5; number++) {
    const uploaded = await uploadKitchenPdfInForm(page, 'kitchen-design-pdf', `new-layout-${number}.pdf`);
    project = uploaded.project;
    expect(project.design_versions).toHaveLength(number);
    expect(project.design_versions.at(-1)).toMatchObject({ number, attachment_ids: [uploaded.attachment.id], final_attachment_id: uploaded.attachment.id, upload_date: kitchenIndiaToday(), handoff_status: 'No' });
  }
  await expect(page.getByTestId('kitchen-design-version')).toContainText('Design 5');
  await page.screenshot({ path: info.outputPath('design-five-numbered-pdfs.png'), fullPage: true });
  await expect(page.getByTestId('kitchen-design-finalize')).toHaveAttribute('aria-pressed', 'false');
  await select(page, 'kitchen-design-version', 'Design 1 · Approved · Finalize PDF');
  await expect(page.getByTestId('kitchen-design-finalize')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId(`kitchen-design-pdf-${first.final_attachment_id}`)).toContainText('design-v1.pdf');
  await page.getByTestId('kitchen-design-finalize').click();
  project = await clickCommand(page, 'kitchen-design-edit-save', 'design_update');
  expect(project.final_design_version_id).toBeNull();
  const denied = await context.request.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: { expected_version: project.version, idempotency_key: randomUUID(), command: 'move_stage', payload: { target_stage: 'quotation' } } });
  expect(denied.status()).toBe(422);
  await page.getByTestId('kitchen-design-finalize').click();
  project = await clickCommand(page, 'kitchen-design-edit-save', 'design_update');
  expect(project.final_design_version_id).toBe(first.id);
  await page.reload();
  await expect(page.getByTestId('kitchen-design-edit-handoff')).toHaveCount(0);
  await clickCommand(page, 'kitchen-advance-quotation', 'move_stage');
  await expect(page.getByTestId('kitchen-quotation-final-design')).toContainText('design-v1.pdf');
  await health.assertHealthy();
});
