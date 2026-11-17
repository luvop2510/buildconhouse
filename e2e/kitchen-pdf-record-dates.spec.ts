import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { kitchenFixtureCommand, prepareKitchenFixtureCommand, uploadKitchenPdfInForm } from './kitchen-pdf-fixtures';

const headers = { 'X-Floor-Id': 'second-floor' };
async function load(api: APIRequestContext, id: string) {
  const response = await api.get(`/api/kitchen-projects/${id}`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function quotation(api: APIRequestContext) {
  const response = await api.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
    lead: { site_location: `PDF date regression ${randomUUID()}` },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  let project = await response.json();
  for (const stage of ['visit', 'cad', 'design', 'quotation']) {
    const prepared = await prepareKitchenFixtureCommand(api, project, 'move_stage', { target_stage: stage });
    project = await kitchenFixtureCommand(api, prepared.project, 'move_stage', prepared.payload);
  }
  return project;
}
async function open(page: Page, id: string) {
  await page.goto(`/kitchen/${id}/stages/quotation`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
}
async function save(page: Page, button: string, command: string) {
  const pending = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === command);
  await page.getByTestId(button).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  return { project: await response.json(), payload: response.request().postDataJSON().payload };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
});

test('Quotation PDF dates persist before upload, through replacement and independent customer date edits', async ({ page, context }) => {
  test.setTimeout(120000);
  let project = await quotation(context.request);
  await open(page, project.id);
  const date = page.getByTestId('kitchen-quotation-upload-date');
  await expect(date).toBeEnabled();
  await expect(date).toHaveValue('');
  await date.fill('2026-10-27');
  await expect(date).toHaveValue('2026-10-27');
  const created = await save(page, 'kitchen-quotation-receive', 'quotation_receive');
  expect(created.payload.upload_date).toBe('2026-10-27');
  expect(created.payload.pdf_options).toEqual([]);
  project = created.project;
  expect(project.quotation_versions.at(-1).upload_date).toBe('2026-10-27');
  await page.reload();
  await expect(date).toHaveValue('2026-10-27');
  await page.goto(`/kitchen/${project.id}/stages/design`);
  await open(page, project.id);
  await expect(date).toHaveValue('2026-10-27');

  await uploadKitchenPdfInForm(page, 'kitchen-quotation-GI-pdf', 'historical-quotation.pdf');
  await expect(date).toHaveValue('2026-10-27');
  project = await load(context.request, project.id);
  const firstFile = project.attachments.at(-1);
  await page.getByTestId(`kitchen-quotation-GI-pdf-${firstFile.id}-final`).click();
  await expect(date).toHaveValue('2026-10-27');
  await page.getByTestId('kitchen-quotation-sent-yes').click();
  await page.getByTestId('kitchen-quotation-shared-date').fill('2026-11-17');
  project = (await save(page, 'kitchen-quotation-edit-save', 'quotation_update')).project;
  const before = structuredClone(project.quotation_versions.at(-1));
  const attachmentBefore = structuredClone(project.attachments);
  await date.fill('2026-10-28');
  const edited = await save(page, 'kitchen-quotation-upload-date-save', 'quotation_update');
  expect(edited.payload).toEqual({ version_id: before.id, upload_date: '2026-10-28' });
  expect(edited.project.quotation_versions.at(-1)).toMatchObject({ shared_date: '2026-11-17', upload_date: '2026-10-28', received_date: before.received_date });
  expect(edited.project.attachments.map(({ upload_date: _date, ...file }: any) => file)).toEqual(attachmentBefore.map(({ upload_date: _date, ...file }: any) => file));
  expect(edited.project.attachments.find((file: any) => file.id === before.final_attachment_id).upload_date).toBe('2026-10-28');
  await page.reload();
  await expect(date).toHaveValue('2026-10-28');

  await uploadKitchenPdfInForm(page, 'kitchen-quotation-Mix-pdf', 'replacement-quotation.pdf');
  project = await load(context.request, project.id);
  await page.getByTestId(`kitchen-quotation-Mix-pdf-${project.attachments.at(-1).id}-final`).click();
  await expect(date).toHaveValue('2026-10-28');
  await page.getByTestId('kitchen-quotation-shared-date').fill('2026-11-16');
  await page.getByTestId('kitchen-version-response-changes-required').click();
  await save(page, 'kitchen-quotation-edit-save', 'quotation_update');
  await page.reload();
  await expect(date).toHaveValue('2026-10-28');
  const final = await load(context.request, project.id);
  expect(final.quotation_versions.at(-1)).toMatchObject({ upload_date: '2026-10-28', shared_date: '2026-11-16', response: 'Changes Required' });
  expect(final.attachments.find((file: any) => file.id === firstFile.id)).toMatchObject({ ...firstFile, upload_date: '2026-10-28' });
});

test('New typing survives an in-flight date save, unrelated drafts survive, and failed saves stay visible', async ({ page, context }) => {
  test.setTimeout(90000);
  let project = await quotation(context.request);
  project = await kitchenFixtureCommand(context.request, project, 'quotation_receive', {
    design_version_id: project.final_design_version_id, pdf_options: [], final_attachment_id: null,
    upload_date: '2026-10-27', sent_status: 'No', response: 'Pending',
  });
  await open(page, project.id);
  const date = page.getByTestId('kitchen-quotation-upload-date');
  await page.getByTestId('kitchen-quotation-sent-yes').click();
  await page.getByTestId('kitchen-quotation-shared-date').fill('2026-11-17');
  await date.fill('2026-10-28');
  let release: () => void = () => {};
  let observed: () => void = () => {};
  const sent = new Promise<void>(resolve => { observed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const endpoint = `**/api/kitchen-projects/${project.id}/commands`;
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    observed();
    await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByTestId('kitchen-quotation-upload-date-save').click();
  await sent;
  await expect(date).toBeEnabled();
  await date.fill('2026-10-29');
  release();
  await expect(page.getByTestId('kitchen-quotation-upload-date-save')).toBeEnabled();
  await expect(date).toHaveValue('2026-10-29');
  await expect(page.getByTestId('kitchen-quotation-shared-date')).toHaveValue('2026-11-17');
  await expect(page.getByTestId('kitchen-quotation-sent-yes')).toHaveAttribute('aria-pressed', 'true');
  await save(page, 'kitchen-quotation-upload-date-save', 'quotation_update');
  expect((await load(context.request, project.id)).quotation_versions.at(-1)).toMatchObject({ upload_date: '2026-10-29', sent_status: 'No', shared_date: null });
  await date.fill('2026-10-30');
  await page.route(endpoint, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic date save failure' }) }), { times: 1 });
  await page.getByTestId('kitchen-quotation-upload-date-save').click();
  await expect(page.getByText(/Synthetic date save failure/).first()).toBeVisible();
  await expect(date).toHaveValue('2026-10-30');
  expect((await load(context.request, project.id)).quotation_versions.at(-1).upload_date).toBe('2026-10-29');
  await save(page, 'kitchen-quotation-upload-date-save', 'quotation_update');
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.reload();
  await expect(date).toHaveValue('2026-10-30');
});
